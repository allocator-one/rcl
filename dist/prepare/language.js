const EXTENSION_MAP = {
    // TypeScript / JavaScript
    ts: 'typescript',
    tsx: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    // Python
    py: 'python',
    pyi: 'python',
    // Elixir / Erlang
    ex: 'elixir',
    exs: 'elixir',
    erl: 'erlang',
    hrl: 'erlang',
    // Ruby
    rb: 'ruby',
    // Go
    go: 'go',
    // Rust
    rs: 'rust',
    // Java / Kotlin
    java: 'java',
    kt: 'kotlin',
    kts: 'kotlin',
    // C / C++
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    // C#
    cs: 'csharp',
    // PHP
    php: 'php',
    // Swift
    swift: 'swift',
    // Shell
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    fish: 'shell',
    // Config / Data
    yml: 'yaml',
    yaml: 'yaml',
    json: 'json',
    toml: 'toml',
    xml: 'xml',
    // Web
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'scss',
    sass: 'sass',
    less: 'less',
    // SQL
    sql: 'sql',
    // Terraform
    tf: 'terraform',
    tfvars: 'terraform',
    // Docker
    dockerfile: 'dockerfile',
    // Markdown / Docs
    md: 'markdown',
    mdx: 'markdown',
    rst: 'rst',
    // GraphQL
    graphql: 'graphql',
    gql: 'graphql',
};
const FILENAME_MAP = {
    Dockerfile: 'dockerfile',
    'docker-compose.yml': 'yaml',
    'docker-compose.yaml': 'yaml',
    Makefile: 'makefile',
    Gemfile: 'ruby',
    Rakefile: 'ruby',
    Podfile: 'ruby',
    '.babelrc': 'json',
    '.eslintrc': 'json',
};
export function detectLanguage(filename) {
    // Check full filename first
    const basename = filename.split('/').pop() ?? filename;
    if (FILENAME_MAP[basename]) {
        return FILENAME_MAP[basename];
    }
    // Check extension
    const ext = basename.split('.').pop()?.toLowerCase();
    if (ext && EXTENSION_MAP[ext]) {
        return EXTENSION_MAP[ext];
    }
    return 'generic';
}
//# sourceMappingURL=language.js.map