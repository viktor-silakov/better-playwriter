# Security policy

## Local browser access

The default relay listens on loopback. Existing tabs become available after the user enables them with the extension icon. Code in a session can open new tabs. Browser output, local logs, and recordings may include private page content and account information.

## Remote control

If a tunnel service is explicitly configured, the extension asks for confirmation before sharing a browser. Anyone with the link can control all enabled tabs and open new tabs until sharing ends. This access includes page content and can include cookies and browser storage. Share the link only with a recipient you trust.

To revoke access, click **Stop sharing**, close or detach the tab where sharing began, or cancel Chrome's debugging banner. New tabs created by the recipient are detached and left open.

For a relay you host yourself, configure an authentication token and use a trusted transport. See [Remote access](./docs/remote-access.md).

## Reporting

Use this project's GitHub **Security → Report a vulnerability** feature if available, or contact the maintainer privately. Include a minimal reproduction with synthetic data. Keep browser logs, session tokens, and any personal or account information private.
