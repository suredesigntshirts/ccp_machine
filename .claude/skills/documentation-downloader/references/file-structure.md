# File Structure and URL Mapping

Rules for converting documentation URLs to local file paths.

## Base Directory

All documentation is stored under:

```
docs/
```

## Domain Mapping

URLs are mapped to local paths using the domain as the first directory level:

| URL Domain | Local Directory |
|------------|-----------------|
| help.getzep.com | `docs/help.getzep.com/` |
| developer.capsulecrm.com | `docs/developer.capsulecrm.com/` |
| docs.example.com | `docs/docs.example.com/` |
| api.stripe.com | `docs/api.stripe.com/` |

**Note:** The `www.` prefix is stripped from domains:
- `www.example.com` → `docs/example.com/`

**Redirects:** The script follows HTTP redirects and uses the **final URL** (after all redirects) to determine the output path. This ensures that e.g. `www.better-auth.com/docs/intro` which redirects to `better-auth.com/docs/intro` is saved under `docs/better-auth.com/`, not `docs/www.better-auth.com/`.

## URL to Path Conversion

### General Rules

1. **Strip the protocol** - Remove `https://` or `http://`
2. **Strip `www.` prefix** - Remove from domain if present
3. **Strip query parameters** - Remove everything after `?`
4. **Strip hash fragments** - Remove everything after `#`
5. **Preserve path structure** - Keep the URL path as directory structure
6. **Add .md extension** - Append `.md` to the final path segment

### Examples

#### API Documentation Sites

```
URL:  https://developer.capsulecrm.com/v2/operations/Party
Path: docs/developer.capsulecrm.com/v2/operations/Party.md

URL:  https://api.stripe.com/v1/customers
Path: docs/api.stripe.com/v1/customers.md
```

#### Help/Knowledge Base Sites

```
URL:  https://help.getzep.com/graphiti/getting-started/quick-start
Path: docs/help.getzep.com/graphiti/getting-started/quick-start.md

URL:  https://help.getzep.com/graphiti/getting-started/quick-start?section=install
Path: docs/help.getzep.com/graphiti/getting-started/quick-start.md
      (query params stripped)
```

#### Documentation Platforms

```
URL:  https://docs.readthedocs.io/en/stable/intro/getting-started.html
Path: docs/docs.readthedocs.io/en/stable/intro/getting-started.md
      (Note: .html extension replaced with .md)

URL:  https://mintlify.com/docs/quickstart
Path: docs/mintlify.com/docs/quickstart.md
```

#### GitHub Documentation

```
URL:  https://github.com/org/repo/blob/main/docs/guide.md
Path: docs/github.com/org/repo/docs/guide.md
      (blob/main stripped as it's git-specific)

URL:  https://raw.githubusercontent.com/org/repo/main/README.md
Path: docs/github.com/org/repo/README.md
      (raw.githubusercontent.com normalized to github.com)
```

## Index File

The index file lives at:

```
docs/llms.txt
```

### Index Format

Entries are grouped by domain:

```
## help.getzep.com

- docs/help.getzep.com/graphiti/getting-started/quick-start.md: Graphiti quick start guide with installation and basic usage.
- docs/help.getzep.com/graphiti/api/client.md: Graphiti Python client API reference.

## developer.capsulecrm.com

- docs/developer.capsulecrm.com/v2/operations/Party.md: Capsule CRM Party (contact/organization) API operations.
- docs/developer.capsulecrm.com/v2/authentication.md: Capsule CRM API authentication guide.
```

### Index Guidelines

- Group entries by domain
- Keep descriptions concise (one line, under 100 chars)
- Include key topics/features covered
- Sort entries alphabetically within each domain section

## Directory Creation

Create directories as needed when saving files:

```bash
# The fetch script handles this automatically with --output
node "$DD_SKILL_DIR"/scripts/fetch-docs.js "<url>" --output "<path>"

# Or manually:
mkdir -p docs/help.getzep.com/graphiti/getting-started/
```

## Handling Special Cases

### Trailing Slashes

URLs with trailing slashes become index files:

```
URL:  https://docs.example.com/api/
Path: docs/docs.example.com/api/index.md
```

### Root Pages

Domain root pages:

```
URL:  https://developer.capsulecrm.com/
Path: docs/developer.capsulecrm.com/index.md
```

### File Extensions

Replace common web extensions with `.md`:

```
URL:  https://example.com/docs/guide.html
Path: docs/example.com/docs/guide.md

URL:  https://example.com/docs/api.htm
Path: docs/example.com/docs/api.md
```

### Version Numbers in Paths

Preserve version numbers:

```
URL:  https://api.example.com/v2/reference
Path: docs/api.example.com/v2/reference.md

URL:  https://docs.example.com/en/stable/guide
Path: docs/docs.example.com/en/stable/guide.md
```

### Subdomains

Preserve subdomains (except `www`):

```
URL:  https://api.github.com/v3/repos
Path: docs/api.github.com/v3/repos.md

URL:  https://docs.github.com/en/rest
Path: docs/docs.github.com/en/rest.md
```
