#!/usr/bin/env python3
"""Announce a verified npm release through Infra One's signed agent webhook.

Runs only trusted default-branch code; release contents are read as evidence.
No third-party Python dependencies and no release/package code execution.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

PROJECTS = {
    'allocator-one/rcl': ('review-council', 'RCL', 'rcl'),
    'allocator-one/harness-cli': ('@allocator-one/harness-cli', 'Harness CLI', 'harness-cli'),
}
STABLE = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z')
MAX_PAYLOAD = 256 * 1024
MAX_RESPONSE = 16 * 1024 * 1024


class NotificationError(Exception):
    """A failure safe to print without credentials or upstream response bodies."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(url, *, headers=None, body=None):
    req = urllib.request.Request(url, data=body, headers=headers or {})
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=30) as response:
            data = response.read(MAX_RESPONSE + 1)
            if len(data) > MAX_RESPONSE:
                raise NotificationError('Response exceeds the size limit')
            return data
    except urllib.error.HTTPError as error:
        raise NotificationError(f'Request failed with HTTP {error.code}') from None
    except (OSError, ValueError):
        raise NotificationError('Request failed or timed out') from None


def json_response(url, *, headers=None):
    try:
        result = json.loads(request(url, headers=headers))
        if not isinstance(result, dict):
            raise ValueError()
        return result
    except (ValueError, UnicodeError):
        raise NotificationError('Invalid JSON response') from None


def validate_run(run, repository):
    tag = run.get('head_branch', '')
    sha = run.get('head_sha', '')
    head_repository = run.get('head_repository')
    if (run.get('path') != '.github/workflows/release.yml'
            or run.get('event') != 'push'
            or run.get('status') != 'completed'
            or run.get('conclusion') != 'success'
            or not isinstance(head_repository, dict)
            or head_repository.get('full_name') != repository
            or not isinstance(tag, str) or not tag.startswith('v') or not STABLE.fullmatch(tag[1:])
            or not isinstance(sha, str) or not re.fullmatch(r'[0-9a-f]{40}', sha)):
        raise NotificationError('Expected a successful stable Release tag run in this repository')
    return tag[1:], sha


def previous_version(metadata, version):
    versions = metadata.get('versions', {})
    if version not in versions:
        raise NotificationError('Release version is not published on npm')
    current = tuple(map(int, version.split('.')))
    earlier = [v for v in versions if STABLE.fullmatch(v) and tuple(map(int, v.split('.'))) < current]
    if not earlier:
        raise NotificationError('No previous stable npm version to compare')
    return max(earlier, key=lambda value: tuple(map(int, value.split('.'))))


def validate_package(package, name, version, sha, *, require_git_head=False):
    if not isinstance(package, dict):
        raise NotificationError('Published package identity does not match the release')
    git_head = package.get('gitHead')
    if (package.get('name') != name
            or package.get('version') != version
            or (git_head is not None and git_head != sha)
            or (require_git_head and (not isinstance(git_head, str) or git_head != sha))):
        raise NotificationError('Published package identity does not match the release')


def text(value, limit):
    return value.encode('utf-8', errors='replace')[:limit].decode('utf-8', errors='ignore') if isinstance(value, str) else ''


def build_payload(repository, version, previous, comparison):
    package, product, _key = PROJECTS[repository]
    commits = []
    commits_for_summary = comparison.get('commits', [])
    if not isinstance(commits_for_summary, list):
        commits_for_summary = []
    for item in commits_for_summary[-80:]:
        author = item.get('author') or {}
        commit = item.get('commit') or {}
        commits.append({
            'sha': text(item.get('sha'), 40),
            'message': text(commit.get('message'), 2000),
            'message_truncated': len((commit.get('message') or '').encode('utf-8')) > 2000,
            'author_name': text((commit.get('author') or {}).get('name'), 150) if author.get('type') != 'Bot' else None,
            'author_login': text(author.get('login'), 100) if author.get('type') == 'User' else None,
        })
    files = sorted(comparison.get('files', []), key=lambda item: item.get('additions', 0) + item.get('deletions', 0), reverse=True)
    url = f'https://github.com/{repository}/compare/v{previous}...v{version}'
    return {
        'source': 'github_actions', 'environment': 'prod', 'repository': repository,
        'product': product, 'package': package, 'current_version': version,
        'previous_version': previous, 'current_tag': f'v{version}', 'previous_tag': f'v{previous}',
        'compare_url': url,
        'npm_url': f'https://www.npmjs.com/package/{package}/v/{version}',
        'release_header': f'**{product} {version}**\n\n',
        'full_diff_footer': f'\n\n[Full diff: v{previous} → v{version}]({url})',
        'total_commits': comparison.get('total_commits', len(commits)),
        'included_commits': len(commits),
        'commits_truncated': comparison.get('total_commits', len(commits)) > len(commits),
        'commits': commits,
        'included_files': min(len(files), 40),
        # GitHub caps the file list at 300: never claim an exact total at that boundary.
        'files_truncated': len(files) > 40,
        'files': [{key: text(item.get(key), 1000) if key in ('filename', 'status') else item.get(key, 0)
                   for key in ('filename', 'status', 'additions', 'deletions')} for item in files[:40]],
    }


def latest_comparison(github, previous, version):
    comparison_path = f'compare/v{previous}...v{version}?per_page=100'
    comparison = github(comparison_path)
    commits = comparison.get('commits')
    total = comparison.get('total_commits')
    if not isinstance(commits, list) or not isinstance(total, int) or total < len(commits):
        raise NotificationError('Release comparison has invalid commit evidence')
    if total <= 100:
        return comparison
    last_page = (total - 1) // 100 + 1
    latest_page = github(f'{comparison_path}&page={last_page}')
    latest_commits = latest_page.get('commits')
    if not isinstance(latest_commits, list):
        raise NotificationError('Release comparison has invalid commit evidence')
    return {**comparison, 'commits': latest_commits}


def encode_payload(payload):
    body = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
    if len(body) > MAX_PAYLOAD:
        raise NotificationError('Release payload exceeds 256 KiB')
    return body


def validate_webhook(url, secret):
    if (not re.fullmatch(r'https://venture\.infra\.one/api/webhooks/automations/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', url)
            or not re.fullmatch(r'[A-Za-z0-9_-]{43}', secret)):
        raise NotificationError('Production webhook configuration is missing or invalid')


def signed_headers(secret, repository, version, body, timestamp):
    digest = hmac.new(secret.encode(), str(timestamp).encode() + b'.' + body, hashlib.sha256).hexdigest()
    return {
        'Content-Type': 'application/json',
        'X-Infra-One-Timestamp': str(timestamp),
        'X-Infra-One-Signature': 'sha256=' + digest,
        'Idempotency-Key': f'{PROJECTS[repository][2]}-npm-v{version}',
    }


def main():
    repository = os.environ.get('GITHUB_REPOSITORY', '')
    run_id = os.environ.get('RELEASE_RUN_ID', '')
    token = os.environ.get('GH_TOKEN', '')
    if repository not in PROJECTS or not re.fullmatch(r'[1-9][0-9]{0,19}', run_id) or not token:
        raise NotificationError('Repository, release run ID or GitHub token is invalid')
    url = os.environ.get('INFRA_ONE_RELEASE_WEBHOOK_URL', '')
    secret = os.environ.get('INFRA_ONE_RELEASE_WEBHOOK_SECRET', '')
    dry_run = os.environ.get('NOTIFICATION_DRY_RUN') == '1'
    if not dry_run:
        validate_webhook(url, secret)
    headers = {'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json',
               'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'infra-one-release-summary'}

    def github(path):
        return json_response(f'https://api.github.com/repos/{repository}/{path}', headers=headers)

    version, sha = validate_run(github(f'actions/runs/{run_id}'), repository)
    if github(f'commits/v{version}').get('sha') != sha:
        raise NotificationError('Release tag no longer matches the successful workflow')
    package_name = PROJECTS[repository][0]
    package_file = github(f'contents/package.json?ref={sha}')
    try:
        source_package = json.loads(base64.b64decode(package_file['content'], validate=False))
    except (KeyError, ValueError, UnicodeError):
        raise NotificationError('Could not decode the release package manifest') from None
    validate_package(source_package, package_name, version, sha)
    registry = f'https://registry.npmjs.org/{urllib.parse.quote(package_name, safe="")}'
    metadata = json_response(registry)
    previous = previous_version(metadata, version)
    versions = metadata.get('versions', {})
    if not isinstance(versions, dict):
        raise NotificationError('Release version is not published on npm')
    validate_package(versions.get(version), package_name, version, sha, require_git_head=True)
    previous_package = versions.get(previous)
    previous_sha = previous_package.get('gitHead') if isinstance(previous_package, dict) else None
    if not isinstance(previous_sha, str) or not re.fullmatch(r'[0-9a-f]{40}', previous_sha):
        raise NotificationError('Previous published package has no verifiable commit')
    if github(f'commits/v{previous}').get('sha') != previous_sha:
        raise NotificationError('Previous release tag does not match the published package')
    comparison = latest_comparison(github, previous, version)
    if comparison.get('status') != 'ahead':
        raise NotificationError('Release comparison must advance from the previous published tag')
    payload = build_payload(repository, version, previous, comparison)
    body = encode_payload(payload)
    if dry_run:
        print(f'Validated {repository} v{version}: {len(body)} bytes, {payload["included_commits"]} commits; no webhook sent.')
        return
    request(url, headers=signed_headers(secret, repository, version, body, int(time.time())), body=body)
    print(f'Accepted {PROJECTS[repository][1]} {version}.')


if __name__ == '__main__':
    try:
        main()
    except NotificationError as error:
        print(f'Release notification failed: {error}', file=sys.stderr)
        sys.exit(1)
