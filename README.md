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

## Requirements

- Node.js (v14 or higher)
- Moodle API token for the student account

## Installation

1. Clone this repository:
```bash
git clone https://github.com/your-username/moodle-mcp-server.git
cd moodle-mcp-server
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file with the following configuration:
```
MOODLE_API_URL=https://your-moodle.com/webservice/rest/server.php
MOODLE_API_TOKEN=your_api_token
```

See [Obtaining a Moodle API Token](#obtaining-a-moodle-api-token) if you do not have a token yet.
Note that on many university sites the token is not available from the admin pages, and the
`.env` file is only read if your MCP client passes these variables through (see the
`env` block under [Usage with Claude](#usage-with-claude)).

4. Build the server:
```bash
npm run build
```

## Usage with Claude

To use with Claude Desktop, add the server configuration:

On MacOS: `~/Library/Application Support/Claude/claude_desktop_config.json`  
On Windows: `%APPDATA%/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "moodle-mcp-server": {
      "command": "/path/to/node",
      "args": [
        "/path/to/moodle-mcp-server/build/index.js"
      ],
      "env": {
        "MOODLE_API_URL": "https://your-moodle.com/webservice/rest/server.php",
        "MOODLE_API_TOKEN": "your_moodle_api_token"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

For Windows users, the paths would use backslashes:

```json
{
  "mcpServers": {
    "moodle-mcp-server": {
      "command": "C:\\path\\to\\node.exe",
      "args": [
        "C:\\path\\to\\moodle-mcp-server\\build\\index.js"
      ],
      "env": {
        "MOODLE_API_URL": "https://your-moodle.com/webservice/rest/server.php",
        "MOODLE_API_TOKEN": "your_moodle_api_token"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Once configured, Claude will be able to:
- List the courses you are enrolled in
- Show which assignments you still need to submit, and when they are due
- Report the grade and feedback you received on an assignment or quiz

## Development

For development with auto-rebuild:
```bash
npm run watch
```

### Debugging

MCP servers communicate through stdio, which can make debugging challenging. We recommend using the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npm run inspector
```

The Inspector will provide a URL to access debugging tools in your browser.

## Obtaining a Moodle API Token

### Option A: the Security keys page

1. Log in to your Moodle site
2. Go to `/user/managetoken.php` (also reachable from your profile as **Security keys**)
3. Look for a row in the **web service tokens** table with a service such as *Moodle mobile web service*
4. Copy that token into your `.env` file

If the page shows only a **Calendar export key** or **RSS token**, you do not have a web service
token. Those keys are 32 hex characters and look identical to a real token, but they are not valid
as a `wstoken` and will fail with `invalidtoken`. Use Option B instead.

### Option B: the mobile service login flow (SSO sites)

Many universities use single sign-on and never grant students a token on the Security keys page. If
the mobile web service is enabled, you can still obtain a token for your own account through the
mobile app's browser login flow.

First check what your site allows:

```bash
curl -s -X POST "https://YOUR-MOODLE/lib/ajax/service-nologin.php?info=tool_mobile_get_public_config" \
  -H 'Content-Type: application/json' \
  -d '[{"index":0,"methodname":"tool_mobile_get_public_config","args":{}}]'
```

You need `enablewebservices: 1` and `enablemobilewebservice: 1` in the response. A `typeoflogin` of
`2` or `3` means the site logs in via browser (SSO), which is the case this flow covers.

Then, **on a desktop browser** — not a phone:

1. Open Chrome DevTools on the **Network** tab and enable **Preserve log**. The token arrives as a
   redirect after login and is lost from the log otherwise.
2. Navigate to the launch URL, replacing `PASSPORT` with any random number:

   ```
   https://YOUR-MOODLE/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=PASSPORT&urlscheme=moodlemobile
   ```

3. Complete the login.
4. The browser will try to open `moodlemobile://token=...` and may prompt *"Open Moodle?"*. Dismiss
   the prompt, then find that URL in the Network log and copy it.
5. Decode it. The payload is **three** `:::`-separated fields — a signature, the token, and a private
   token — so the base64 string itself is not the token:

   ```bash
   BLOB='moodlemobile://token=PASTE_HERE'
   printf '%s' "${BLOB##*token=}" | base64 -d 2>/dev/null || printf '%s' "${BLOB##*token=}" | base64 -D
   ```

   Take the **middle** field (32 hex characters) as your `MOODLE_API_TOKEN`.

Do not run this flow on a phone with the Moodle app installed: the OS hands the URL to the app,
which stores the token internally where you cannot read it.

### Verifying the token

```bash
curl -s -X POST "https://YOUR-MOODLE/webservice/rest/server.php" \
  -d "wstoken=YOUR_TOKEN" \
  -d "wsfunction=core_webservice_get_site_info" \
  -d "moodlewsrestformat=json"
```

A valid token returns your `username`, `userid`, and the list of functions the service exposes. An
invalid one returns `{"errorcode":"invalidtoken","message":"Invalid token - token not found"}`.

Note that a function appearing in that list means the *service* exposes it, not that your account
may call it. Per-course capability checks still apply, so calls needing a teacher role fail with
`nopermissions` even when the function is listed. The tools in this server only read your own data,
so this does not affect normal use.

### Worked example: Aalto University MyCourses

`mycourses.aalto.fi` is SSO-only and grants students no token on the Security keys page, so
Option B is required:

```
MOODLE_API_URL=https://mycourses.aalto.fi/webservice/rest/server.php
```

Launch URL:

```
https://mycourses.aalto.fi/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=12345678&urlscheme=moodlemobile
```

## Security

- Never share your `.env` file or Moodle API token
- The token determines whose data the server can read - use your own student token
- Use a token with the minimum necessary permissions

## License

[MIT](LICENSE)
