# Better Playwriter Chrome extension

Better Playwriter connects the Chrome tabs you enable to a local relay for Playwright, CLI, and MCP clients.

## Install and connect

Use the Better Playwriter listing in Chrome Web Store once published. For a release ZIP or a local build, open `chrome://extensions`, enable **Developer mode**, and load the extracted folder or `extension/dist`. See the [project README](../README.md) for the CLI and build instructions.

Open a tab and click the extension icon to attach it. Start `better-playwriter session new` to bring up the relay. The icon turns green when the tab connects. Click it again to detach the tab.

Manually connecting an HTTP(S) tab remembers its origin in this Chrome profile. Edit or remove masks such as `http://example.com*` or `https://example.com/docs/*` in **Options**. An origin mask matches the same scheme, host and port. The options also let you turn off learning new sites. Detaching manually keeps that tab disconnected until you connect it again.

Right-click the icon and choose **Assign tab to session** to give an attached tab you opened to one local session. **Release to all local sessions** makes it shared again. **RUN** means an agent is using the tab, and **WAIT** means it asked you for a step. **Stop agent** interrupts the current run and keeps the tab open.

Use **Record Skill** in the toolbar to record just that tab, then stop from the same tab.

## Permissions

- `debugger` connects to authorized tabs through Chrome DevTools Protocol.
- `scripting` injects the toolbar and locator picker where used.
- `tabGroups` and `contextMenus` group session tabs and add tab, locator, and sharing actions.
- `offscreen` and `clipboardWrite` support clipboard and audio actions initiated from the extension.
- `storage` stores extension state and URL masks.
- `identity` and `identity.email` help the local relay distinguish Chrome profiles.
- `webNavigation` tracks navigation and popups for enabled tabs.
- Host access allows the extension to operate on sites the user chooses.

With the default configuration, extension traffic goes to the local relay. If explicitly configured, Remote control shares enabled tabs through the configured tunnel after the user confirms. See [Security](../SECURITY.md) for what the recipient can access and how to stop sharing.
