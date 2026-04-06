export const PYTHON_PROMPT_ADDITION = `## Python-Specific Review Areas

- Type hints: missing annotations on public APIs, incorrect Optional usage, missing Union types
- Exception handling: bare \`except:\`, swallowing exceptions, catching BaseException
- Mutable default arguments: \`def f(x=[]):\` antipattern
- SQL injection: f-strings or % formatting in SQL queries
- Security: \`eval()\`, \`exec()\`, \`pickle\` deserialization of untrusted data, subprocess shell=True
- Async/await: mixing sync and async incorrectly, blocking calls in async context
- Resource management: missing context managers for file/network/DB resources
- Import issues: circular imports, wildcard imports (\`from x import *\`)
- Django/Flask specific: missing \`@login_required\`, mass assignment vulnerabilities, debug=True in production
- Testing: missing fixtures teardown, test pollution via shared state
- Performance: list comprehension vs generator for large datasets, unnecessary copies`;
//# sourceMappingURL=python.js.map