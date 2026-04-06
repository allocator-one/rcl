export const ELIXIR_PROMPT_ADDITION = `## Elixir-Specific Review Areas

- Pattern matching: non-exhaustive patterns, missing \`_\` catch-all where appropriate
- Process model: GenServer misuse, message queue saturation, unlinked processes
- Error handling: bare \`case\` without error path, unchecked \`{:error, _}\` returns
- OTP patterns: supervision tree correctness, restart strategies, child spec issues
- Ecto: N+1 queries via missing preload, missing indexes in migrations, SQL injection via raw queries
- Phoenix: missing CSRF protection, insecure plug pipelines, missing authentication plugs
- Concurrency: shared state via ETS without proper locking, race conditions in handle_cast
- Memory: large message passing, binary reference leaks
- Documentation: missing @spec typespecs on public functions, missing @moduledoc
- Telemetry and observability gaps`;
