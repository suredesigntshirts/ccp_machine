# Markdown Formatting Guidelines

Standards for converting web documentation to GitHub-flavored markdown.

## Front Matter

Every document must include YAML front matter:

```yaml
---
Source: https://help.getzep.com/graphiti/getting-started/quick-start
Generated: 2024-12-09
Updated: 2024-12-09
---
```

| Field | Description |
|-------|-------------|
| Source | Original URL of the documentation |
| Generated | Date the document was first created (YYYY-MM-DD) |
| Updated | Date of last update (YYYY-MM-DD) |

## Document Structure

### Title

Use the page's main heading as an H1:

```markdown
# Page Title
```

### Sections

Use ATX-style headings (# prefix):

```markdown
# H1 - Page Title
## H2 - Major Section
### H3 - Subsection
#### H4 - Sub-subsection
```

### Navigation Links

Add back link at the top (after front matter):

```markdown
[Back to Index](../llms.txt)
```

Add footer with source link:

```markdown
---
[Source](https://original-url)
```

## Content Formatting

### Code Blocks

Always use fenced code blocks with language hints:

```markdown
```python
from graphiti import Client
client = Client()
```
```

Common language hints:
- `javascript` / `js` - JavaScript code
- `typescript` / `ts` - TypeScript code
- `python` - Python code
- `bash` / `shell` - Command line
- `json` - JSON data
- `html` - HTML markup
- `http` - HTTP requests/responses
- `yaml` - YAML configuration
- `go` - Go code
- `rust` - Rust code
- `ruby` - Ruby code
- `java` - Java code
- `csharp` / `cs` - C# code
- `sql` - SQL queries
- `graphql` - GraphQL queries

### Inline Code

Use backticks for:
- Function names: `client.search()`
- Parameter names: `query_text`
- File names: `config.yaml`
- Commands: `pip install graphiti`
- Environment variables: `GRAPHITI_API_KEY`

### Tables

Use GitHub-flavored markdown tables:

```markdown
| Parameter | Type | Description |
|-----------|------|-------------|
| query | string | Search query text |
| limit | number | Max results to return |
```

- Header row required
- Separator row with dashes
- Align columns with pipes
- No trailing pipes required but recommended

### Lists

Unordered lists use dashes:

```markdown
- First item
- Second item
  - Nested item
```

Ordered lists use numbers:

```markdown
1. First step
2. Second step
3. Third step
```

### Links

Use inline links:

```markdown
See the [Getting Started guide](./getting-started.md) for more information.
```

External links should use full URLs:

```markdown
Refer to the [official documentation](https://docs.example.com/...).
```

### Images

Include alt text and use descriptive names:

```markdown
![Architecture diagram](./images/architecture.png)
```

## Content to Remove

Remove these elements during conversion:

- Navigation menus and sidebars
- Page headers (site branding, not content headers)
- Page footers (copyright, site links)
- Cookie banners and consent dialogs
- Feedback forms and rating widgets
- Share buttons and social links
- Related content suggestions
- Breadcrumb navigation
- Search boxes
- Login/signup prompts
- Newsletter signup forms
- Chat widgets

## Content to Preserve

Keep these elements:

- Main content area
- Code examples with syntax highlighting
- Tables and data
- Images that illustrate concepts
- Internal anchor links (convert to markdown anchors)
- Warning/note callouts (convert to blockquotes)
- API parameter descriptions
- Example requests/responses

## Callouts and Notes

Convert callout boxes to blockquotes with bold labels:

```markdown
> **Note:** This is important information.

> **Warning:** This may cause issues.

> **Tip:** This is a helpful suggestion.

> **Important:** Critical information here.
```

## API Documentation Specifics

### Endpoints

Format API endpoints clearly:

```markdown
### GET /api/v1/users

Retrieves a list of users.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| limit | integer | No | Max results (default: 20) |
| offset | integer | No | Pagination offset |

**Response:**

```json
{
  "users": [...],
  "total": 100
}
```
```

### Authentication

Document authentication methods clearly:

```markdown
## Authentication

All API requests require authentication via Bearer token:

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" \
  https://api.example.com/v1/users
```
```

## Whitespace

- One blank line between sections
- No trailing whitespace on lines
- Single newline at end of file
- No more than two consecutive blank lines
