import base64
import contextlib
import io
import os
from unittest.mock import patch
import hashlib
import hmac
import importlib.util
import json
from pathlib import Path
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'release_notification.py'
spec = importlib.util.spec_from_file_location('notification', SCRIPT)
n = importlib.util.module_from_spec(spec)
spec.loader.exec_module(n)


class ReleaseNotificationTest(unittest.TestCase):
    def run_data(self, **overrides):
        return {'id': 42, 'path': '.github/workflows/release.yml', 'event': 'push',
                'status': 'completed', 'conclusion': 'success', 'head_branch': 'v4.1.6',
                'head_sha': 'a' * 40, 'run_attempt': 1, 'head_repository': {'full_name': 'allocator-one/rcl'},
                **overrides}

    def test_only_successful_stable_release_runs_from_this_repository(self):
        self.assertEqual(n.validate_run(self.run_data(path='.github/workflows/release.yml@main'), 'allocator-one/rcl'),
                         ('4.1.6', 'a' * 40, 1))
        for change in [{'conclusion': 'failure'}, {'status': 'in_progress'},
                       {'event': 'pull_request'}, {'head_branch': 'main'},
                       {'head_branch': 'v4.1.6-beta.1'}, {'path': '.github/workflows/ci.yml'},
                       {'head_repository': {'full_name': 'attacker/rcl'}}, {'head_repository': None},
                       {'head_branch': None}, {'head_sha': None}, {'run_attempt': 0}]:
            with self.subTest(change=change), self.assertRaises(n.NotificationError):
                n.validate_run(self.run_data(**change), 'allocator-one/rcl')

    def test_previous_published_stable_version_ignores_newer_and_prerelease(self):
        self.assertEqual(n.previous_version({'versions': {'4.1.5': {}, '4.1.6': {}, '4.1.7': {},
                                                            '4.1.6-beta.1': {}, '3.10.0': {}}}, '4.1.6'), '4.1.5')
        with self.assertRaises(n.NotificationError):
            n.previous_version({'versions': {'4.1.5': {}}}, '4.1.6')

    def test_payload_bounds_evidence_and_labels_product(self):
        comparison = {'total_commits': 301, 'commits': [
            {'sha': 'b' * 40, 'commit': {'message': 'a' * 10000, 'author': {'name': 'Ada', 'email': 'private@example.com'}},
             'author': {'login': 'ada', 'type': 'User'}} for _ in range(100)],
            'files': [{'filename': f'{i}.py', 'status': 'modified', 'additions': i, 'deletions': 1} for i in range(300)]}
        p = n.build_payload('allocator-one/rcl', '4.1.6', '4.1.5', comparison)
        self.assertEqual(p['release_header'], '**RCL 4.1.6**\n\n')
        self.assertIn('v4.1.5...v4.1.6', p['full_diff_footer'])
        self.assertTrue(p['commits_truncated'])
        self.assertTrue(p['files_truncated'])
        self.assertLess(len(n.encode_payload(p)), 256 * 1024)
        self.assertNotIn('private@example.com', json.dumps(p))
        self.assertEqual(p['commits'][0]['author_name'], 'Ada')

    def test_payload_keeps_the_most_recent_bounded_commits(self):
        comparison = {'total_commits': 81, 'commits': [
            {'sha': f'{index:040x}', 'commit': {'message': str(index), 'author': {}}, 'author': {}}
            for index in range(81)]}
        payload = n.build_payload('allocator-one/rcl', '4.1.6', '4.1.5', comparison)
        self.assertEqual(payload['included_commits'], 80)
        self.assertEqual(payload['commits'][0]['message'], '1')
        self.assertEqual(payload['commits'][-1]['message'], '80')

    def test_comparison_fetches_last_page_when_initial_page_is_not_complete(self):
        calls = []

        def github(path):
            calls.append(path)
            return ({'total_commits': 101, 'commits': [{'sha': str(index)} for index in range(1, 101)]}
                    if len(calls) == 1 else {'commits': [{'sha': '101'}]})

        comparison = n.latest_comparison(github, 'b' * 40, 'a' * 40)
        self.assertEqual([commit['sha'] for commit in comparison['commits']], [str(index) for index in range(22, 102)])
        self.assertEqual(calls, [f'compare/{"b" * 40}...{"a" * 40}?per_page=100',
                                 f'compare/{"b" * 40}...{"a" * 40}?per_page=100&page=2'])

    def test_attestation_requires_expected_subject_workflow_commit_and_run(self):
        digest = b'x' * 64
        integrity = 'sha512-' + base64.b64encode(digest).decode()
        payload = {'predicateType': n.SLSA_V1,
                   'subject': [{'name': 'pkg:npm/review-council@4.1.6', 'digest': {'sha512': digest.hex()}}],
                   'predicate': {'buildDefinition': {'externalParameters': {'workflow': {
                       'repository': 'https://github.com/allocator-one/rcl', 'path': '.github/workflows/release.yml',
                       'ref': 'refs/tags/v4.1.6'}}, 'resolvedDependencies': [{'digest': {'gitCommit': 'a' * 40}}]},
                                 'runDetails': {'metadata': {'invocationId':
                                     'https://github.com/allocator-one/rcl/actions/runs/42/attempts/1'}}}}
        attestation = {'attestations': [{'bundle': {'dsseEnvelope': {
            'payload': base64.b64encode(json.dumps(payload).encode()).decode()}}}]}
        document = {'dist': {'integrity': integrity, 'attestations': {'url': n.attestation_url('review-council', '4.1.6')},
                              }, 'attestations': attestation['attestations']}
        n.validate_attestation(document, 'review-council', '4.1.6', 'allocator-one/rcl', 'a' * 40, '42', 1)
        document['attestations'][0]['bundle']['dsseEnvelope']['payload'] = base64.b64encode(json.dumps({**payload, 'subject': []}).encode()).decode()
        with self.assertRaises(n.NotificationError):
            n.validate_attestation(document, 'review-council', '4.1.6', 'allocator-one/rcl', 'a' * 40, '42', 1)

    def test_signature_binds_exact_bytes_and_key_is_product_version_stable(self):
        body = n.encode_payload({'current_version': '4.1.6'})
        headers = n.signed_headers('x' * 43, 'allocator-one/rcl', '4.1.6', body, 123)
        expected = hmac.new(('x' * 43).encode(), b'123.' + body, hashlib.sha256).hexdigest()
        self.assertEqual(headers['X-Infra-One-Signature'], 'sha256=' + expected)
        self.assertEqual(headers['Idempotency-Key'], 'rcl-npm-v4.1.6')
        self.assertNotEqual(headers['Idempotency-Key'], n.signed_headers('x' * 43, 'allocator-one/harness-cli', '4.1.6', body, 123)['Idempotency-Key'])

    def test_rejects_wrong_publication_identity(self):
        n.validate_package({'name': 'review-council', 'version': '4.1.6'}, 'review-council', '4.1.6', 'a' * 40)
        for publication in [{'name': 'other', 'version': '4.1.6'},
                            {'name': 'review-council', 'version': '4.1.5'},
                            {'name': 'review-council', 'version': '4.1.6', 'gitHead': 'b' * 40}]:
            with self.assertRaises(n.NotificationError):
                n.validate_package(publication, 'review-council', '4.1.6', 'a' * 40)

    def test_end_to_end_verification_posts_only_after_all_evidence_matches(self):
        manifest = {'name': 'review-council', 'version': '4.1.6'}
        published_manifest = {**manifest, 'gitHead': 'a' * 40}
        previous_manifest = {'name': 'review-council', 'version': '4.1.5', 'gitHead': 'b' * 40}
        responses = [self.run_data(), {'sha': 'a' * 40},
                     {'content': base64.b64encode(json.dumps(manifest).encode()).decode()},
                     {'versions': {'4.1.5': previous_manifest, '4.1.6': published_manifest}},
                     {'sha': 'b' * 40},
                     {'status': 'ahead', 'total_commits': 1, 'commits': [], 'files': []}]
        env = {'GITHUB_REPOSITORY': 'allocator-one/rcl', 'RELEASE_RUN_ID': '42', 'GH_TOKEN': 'private-github-token',
               'INFRA_ONE_RELEASE_WEBHOOK_URL': 'https://venture.infra.one/api/webhooks/automations/56840af9-aa90-4afe-98cf-45fcd42bd0fe',
               'INFRA_ONE_RELEASE_WEBHOOK_SECRET': 'x' * 43}
        with patch.dict(os.environ, env, clear=True), patch.object(n, 'json_response', side_effect=responses), \
                patch.object(n, 'request', return_value=b'') as post, \
                contextlib.redirect_stdout(io.StringIO()):
            n.main()
        self.assertEqual(post.call_count, 1)
        self.assertNotIn('Authorization', post.call_args.kwargs['headers'])
        self.assertEqual(json.loads(post.call_args.kwargs['body'])['current_version'], '4.1.6')
        self.assertEqual(post.call_args.kwargs['headers']['Idempotency-Key'], 'rcl-npm-v4.1.6')

    def test_failed_run_and_moved_tag_never_send_to_webhook(self):
        env = {'GITHUB_REPOSITORY': 'allocator-one/rcl', 'RELEASE_RUN_ID': '42', 'GH_TOKEN': 'private-github-token',
               'INFRA_ONE_RELEASE_WEBHOOK_URL': 'https://venture.infra.one/api/webhooks/automations/56840af9-aa90-4afe-98cf-45fcd42bd0fe',
               'INFRA_ONE_RELEASE_WEBHOOK_SECRET': 'x' * 43}
        for replies in [[self.run_data(conclusion='failure')], [self.run_data(), {'sha': 'b' * 40}]]:
            with patch.dict(os.environ, env, clear=True), patch.object(n, 'json_response', side_effect=replies), \
                    patch.object(n, 'request') as post, self.assertRaises(n.NotificationError):
                n.main()
            post.assert_not_called()

    def test_rejects_redirects_and_non_production_webhook_configuration(self):
        good = 'https://venture.infra.one/api/webhooks/automations/56840af9-aa90-4afe-98cf-45fcd42bd0fe'
        n.validate_webhook(good, 'x' * 43)
        for url in [good + '?token=1', good.replace('venture.infra.one', 'evil.example'),
                    good.replace('https:', 'http:'), good.replace('/api/', ':444/api/')]:
            with self.assertRaises(n.NotificationError):
                n.validate_webhook(url, 'x' * 43)
        self.assertIsNone(n.NoRedirect().redirect_request(None, None, 302, '', {}, good))


if __name__ == '__main__':
    unittest.main()
