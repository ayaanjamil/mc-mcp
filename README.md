# Moodle MCP Server

An MCP (Model Context Protocol) server that enables LLMs to interact with the Moodle platform on behalf of a student — viewing enrolled courses, upcoming assignments, and their own grades and feedback.

The server acts only as the user who owns the API token, and it is read-only: there are no tools for listing other students, viewing their submissions, or grading.

## Features

### Course Tools
- `get_my_courses` - Retrieves the courses the user is enrolled in
  - Includes ID, short name, full name, start/end dates, and completion progress

### Assignment Tools
- `get_assignments` - Retrieves the assignments across the user's courses
  - Includes ID, name, due date, cut-off date, and maximum grade
  - Optionally scoped to a single course with `courseId`
- `get_pending_assignments` - Retrieves the assignments the user has not submitted yet
  - Sorted by due date, with the submission status for each
  - Optionally scoped to a single course with `courseId`
- `get_my_submission_status` - Retrieves the user's own submission for an assignment
  - Requires `assignmentId`
  - Includes submission status, grading status, grade, and feedback received

### Quiz Tools
- `get_quizzes` - Retrieves the quizzes across the user's courses
  - Includes ID, name, and opening/closing dates
  - Optionally scoped to a single course with `courseId`
- `get_my_quiz_grade` - Retrieves the user's own best grade on a quiz
  - Requires `quizId`

### Diagnostics
- `moodle_check_setup` - Reports whether the connection is working
  - Checks the settings file, whether the site is reachable, and whether the token is still valid
  - Works even when nothing is configured yet, so you can ask Claude why Moodle is not working

## Requirements

- Node.js 18 or newer
- A Moodle account (a student account is enough)

## Installation

```bash
git clone <your fork's URL> moodle-mcp-server
cd moodle-mcp-server
npm install
npm run setup
```

That is the whole install. `npm run setup` walks you through signing in to your
Moodle site once, gets a token for your own account, checks it works, and stores
it in `~/.config/moodle-mcp/config.json` (readable only by you).

You do not need to find a token by hand, and you do not need a `.env` file.
If you would rather do it manually anyway, see
[Manual token setup](#manual-token-setup-advanced).

Setup finishes by printing the exact snippet to paste into your Claude client,
with the real paths already filled in. It does not edit your Claude
configuration for you. You can print those snippets again at any time:

```bash
npm run setup -- --print-client-config
```

### Options

```
npm run setup -- --help
```

| Flag | What it does |
| --- | --- |
| `--doctor` | Check an existing setup instead of creating one (same as `npm run doctor`) |
| `--json` | With `--doctor`, print machine-readable output |
| `--site <address>` | Skip the site question, e.g. `--site mycourses.aalto.fi` |
| `--token <token>` | Set the token directly, no prompts. Puts the token in your shell history |
| `--force` | Reconfigure even if you are already set up |
| `--no-clipboard` | Do not watch the clipboard; paste the link instead |
| `--no-browser` | Print the sign-in link rather than opening a browser |

## Usage with Claude

Setup prints the snippet for your platform. It looks like this:

**Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json`
on macOS, `%APPDATA%/Claude/claude_desktop_config.json` on Windows:

```json
{
  "mcpServers": {
    "moodle": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/moodle-mcp-server/build/index.js"]
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add moodle --scope user -- /absolute/path/to/node /absolute/path/to/moodle-mcp-server/build/index.js
```

Two things worth knowing about that snippet:

- **Use the absolute path to `node`, not `"node"`.** Claude Desktop launches from
  the GUI with a minimal `PATH` that does not include nvm or Homebrew, so
  `"command": "node"` is a common cause of "server disconnected". Setup fills in
  the absolute path for you.
- **There is no token in it.** The token lives in your settings file, so you can
  re-run `npm run setup` without touching Claude's configuration.

If you already have other servers listed, add the `"moodle"` block alongside
them rather than replacing the file. Then quit Claude Desktop completely
(Cmd+Q, not just the window) and open it again.

Once configured, Claude can:
- List the courses you are enrolled in
- Show which assignments you still need to submit, and when they are due
- Report the grade and feedback you received on an assignment or quiz

Try: *"What Moodle assignments do I have due this week?"*

## When something goes wrong

Run the checkup first. It tests every step separately, so it can tell
"your token expired" apart from "the site turned web services off":

```bash
npm run doctor
```

You can also just ask Claude — the `moodle_check_setup` tool runs the same
checks and works even when nothing is configured yet.

| What you see | What it means | Fix |
| --- | --- | --- |
| `Moodle is not connected yet.` | No settings file, and no environment variables either | `npm run setup` |
| `Your Moodle token is no longer valid.` | Moodle revoked the token, usually after a password change | `npm run setup`. No Claude restart needed |
| `The Moodle settings file at ... is damaged` | The config file is not valid JSON | `npm run setup` recreates it |
| `Moodle refused the token (accessexception).` | Web services off site-wide, or the token is restricted to another network | `npm run doctor` |
| `Your account is not allowed to read that.` | The course hides that item from students | Nothing to fix; the tools only read your own data |
| `The Moodle mobile web service is not enabled` | The site has not enabled it | Ask your Moodle administrator |
| `Could not find <host>.` | The site address is misspelled, or you are offline | `npm run setup` and re-enter it |
| `Could not reach <host>.` | Network, or your Moodle needs the university VPN | Connect to the VPN and retry |
| `Web services are turned off on ...` | Site-wide setting | Ask an administrator to enable web services |
| Claude shows the server as disconnected | Usually a stale build or a `node` path that no longer exists | `npm install && npm run doctor` |

`npm run doctor` also warns when `MOODLE_API_URL` or `MOODLE_API_TOKEN` are set
in your environment, because those override the settings file and otherwise make
"I re-ran setup and it still uses the old token" impossible to diagnose.

## Where your token is stored

`~/.config/moodle-mcp/config.json`, with permissions `600` in a directory with
permissions `700`, so only your user account can read it. The file holds your
Moodle address and the token, and nothing else. The private token that Moodle
issues alongside it is deliberately discarded, since nothing here uses it.

For backwards compatibility, `MOODLE_API_URL` and `MOODLE_API_TOKEN` still work
and take precedence per field, so an existing `env` block in your Claude
configuration keeps working untouched.

## Development

For development with auto-rebuild:
```bash
npm run watch
```

Run the tests:
```bash
npm test
```

These cover the pure functions: token parsing (five input shapes, including the
trap that a bare 32-hex token is also valid base64 and must not be decoded),
site URL normalisation, and the config file round-trip.

### Debugging

MCP servers communicate through stdio, which can make debugging challenging. We recommend using the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npm run inspector
```

The Inspector will provide a URL to access debugging tools in your browser.

## Manual token setup (advanced)

`npm run setup` does all of this for you. This section is here for debugging, or
if you would rather not run the wizard.

<details>
<summary>Get a token by hand</summary>

### First, check what your site allows

```bash
curl -s -X POST "https://YOUR-MOODLE/lib/ajax/service-nologin.php?info=tool_mobile_get_public_config" \
  -H 'Content-Type: application/json' \
  -d '[{"index":0,"methodname":"tool_mobile_get_public_config","args":{}}]'
```

You need `enablewebservices: 1` and `enablemobilewebservice: 1`. The
`typeoflogin` field tells you which route applies:

- `1` — the site has its own login form. Try **Option A**.
- `2` or `3` — the site logs in through the browser (single sign-on, as at
  Aalto). Use **Option B**.

### Option A: the Security keys page

1. Log in to your Moodle site
2. Go to `/user/managetoken.php` (in your profile as **Security keys**)
3. Find a row whose service is something like *Moodle mobile web service*
4. Copy that token

If the page only shows a **Calendar export key** or **RSS token**, you do not
have a web service token. Those are also 32 hex characters and look identical,
but they are not valid as a `wstoken` and fail with `invalidtoken`. There is no
way to tell them apart by looking; only a live check can. Use Option B.

### Option B: the mobile service login flow (SSO sites)

Many universities use single sign-on and never grant students a token on the
Security keys page. The mobile app's browser login flow still works.

On a desktop browser, open this, replacing `PASSPORT` with any random number:

```
https://YOUR-MOODLE/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=PASSPORT&urlscheme=moodlemcp&confirmed=1
```

`confirmed=1` is the important part. Without it Moodle immediately redirects to
`moodlemobile://token=...` and you have to dig the URL out of DevTools. With it,
Moodle renders a normal page containing a **"Click here to launch the app"**
link instead.

1. Sign in as usual
2. Right-click that link and choose **Copy Link Address** (Safari: *Copy Link*)
3. Decode it. The payload has three `:::`-separated fields — a site signature,
   the token, and a private token — so the base64 string itself is not the token:

   ```bash
   BLOB='moodlemobile://token=PASTE_HERE'
   printf '%s' "${BLOB##*token=}" | base64 -d 2>/dev/null || printf '%s' "${BLOB##*token=}" | base64 -D
   ```

   Take the **middle** field (32 hex characters). Note the first field is also
   32 hex characters, so "the hex-looking one" is ambiguous — it has to be the
   second.

You may see a small popup when the page tries to open the link. Dismiss it; the
link stays on the page either way.

### Verifying a token

```bash
curl -s -X POST "https://YOUR-MOODLE/webservice/rest/server.php" \
  -d "wstoken=YOUR_TOKEN" \
  -d "wsfunction=core_webservice_get_site_info" \
  -d "moodlewsrestformat=json"
```

A valid token returns your `username`, `userid`, and the functions the service
exposes. An invalid one returns
`{"errorcode":"invalidtoken","message":"Invalid token - token not found"}` —
with HTTP status **200**, which is why naive clients miss it.

A function appearing in that list means the *service* exposes it, not that your
account may call it. Per-course capability checks still apply. The tools here
only read your own data, so this does not affect normal use.

### Using a token you already have

```bash
npm run setup -- --site YOUR-MOODLE --token YOUR_TOKEN
```

This still verifies the token against the site before saving it.

</details>

## Security

- Never share your `.env` file or Moodle API token
- The token determines whose data the server can read - use your own student token
- Use a token with the minimum necessary permissions

## License

[MIT](LICENSE)

## Credits

A fork of [peancor/moodle-mcp-server](https://github.com/peancor/moodle-mcp-server),
rewritten around a read-only student tool set and a guided setup flow. MIT licensed.
