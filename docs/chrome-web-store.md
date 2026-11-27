# Chrome Web Store releases

## Build the extension ZIP

From the repository root, use Node.js, pnpm, Bun, and Git with submodule support:

```bash
pnpm bootstrap
pnpm release
```

The production ZIP is `better-playwriter-<version>.zip`. Its `manifest.json` is at the ZIP root. Preview it by extracting the ZIP and choosing **Load unpacked** in `chrome://extensions` on a test browser profile. For a manual preview of the unpacked production ZIP, start the CLI with `BETTER_PLAYWRITER_STORE_ID` set to the ID shown on its Chrome extension card. Connect a tab and verify a local session before submitting it.

## First submission

The Chrome Web Store API updates existing items. Create the first Better Playwriter item in the Developer Dashboard and upload its first ZIP there. Use an account with two-step verification. Save the publisher ID and the new extension ID from the dashboard. Set the public extension ID as `betterPlaywriter.storeId` in `playwriter/package.json` before publishing the CLI so its install guidance points to this listing.

Prepare the listing, including the extension icon and a screenshot from a clean profile. Describe the single purpose of the extension and justify each manifest permission. Explain that the local relay can receive browser data and profile information. Include the hosted privacy policy and reviewer steps to install the matching CLI, open a test page, connect the tab, and run a local session.

Choose **Unlisted** to start with an install-by-link release or **Public** for a listing in search. Visibility changes need a manual publication in the dashboard before API publishing resumes.

- [First publication](https://developer.chrome.com/docs/webstore/publish)
- [Privacy disclosures](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [Distribution options](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)

## Configure automatic updates

Enable Chrome Web Store API in a Google Cloud project. Create a service account and add it to your publisher in the Developer Dashboard. Configure GitHub Actions OIDC through Workload Identity Federation and grant the federated identity permission to impersonate that account. Restrict the trust condition to the intended GitHub repository, workflow, and `chrome-web-store` deployment environment.

Set the repository Actions variable `CWS_REPOSITORY` to the exact `owner/repository` value. Create the `chrome-web-store` Actions environment with these environment secrets:

| Variable | Value |
| --- | --- |
| `CWS_PUBLISHER_ID` | Publisher ID from the Developer Dashboard. |
| `CWS_EXTENSION_ID` | ID of the Better Playwriter store item. |
| `CWS_WORKLOAD_IDENTITY_PROVIDER` | Full resource name of the Workload Identity Provider. |
| `CWS_SERVICE_ACCOUNT` | Service account linked to the publisher. |

GitHub exchanges its OIDC token for a short-lived access token. Keep service-account keys and credentials out of the repository and artifacts. [Google service accounts](https://developer.chrome.com/docs/webstore/service-accounts) · [GitHub OIDC setup](https://github.com/google-github-actions/auth)

## Publish an update

1. Bump `extension/manifest.json` and ensure the matching `better-playwriter` CLI version is in npm.
2. Publish a GitHub Release for the corresponding `extension@<version>` tag. Use a regular release to send it to the store. Publishing a tag alone does not send a ZIP to the store.
3. The Chrome Web Store workflow builds and checks the ZIP. It uploads the package and submits it to Google for review.
4. Use the workflow's manual status action to check the item. Treat the update as available after the store reports it published and a clean profile can install it.

The first submission and any visibility changes are managed in the Developer Dashboard. [Chrome Web Store API v2](https://developer.chrome.com/docs/webstore/using-api)
