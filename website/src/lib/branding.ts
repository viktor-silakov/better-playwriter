import { betterPlaywriter } from '../../../playwriter/package.json'

const { storeId } = betterPlaywriter

export const extensionInstallUrl = storeId
  ? `https://chromewebstore.google.com/detail/${storeId}`
  : '/docs/installation'
