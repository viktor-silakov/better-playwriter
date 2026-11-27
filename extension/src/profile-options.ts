import {
  AUTO_ATTACH_STORAGE_KEY,
  normalizeAutoAttachMask,
  readAutoAttachSettings,
} from 'better-playwriter/src/auto-attach-rules'

const masksInput = document.querySelector<HTMLTextAreaElement>('#masks')!
const rememberInput = document.querySelector<HTMLInputElement>('#remember')!
const masksStatus = document.querySelector<HTMLOutputElement>('#masks-status')!
const masksSaveButton = document.querySelector<HTMLButtonElement>('#save-masks')!

void chrome.storage.local.get(AUTO_ATTACH_STORAGE_KEY).then(
  (stored) => {
    const settings = readAutoAttachSettings(stored[AUTO_ATTACH_STORAGE_KEY])
    masksInput.value = settings.masks.join('\n')
    rememberInput.checked = settings.remember
    masksSaveButton.disabled = false
  },
  () => {
    masksStatus.textContent = ' Could not load URL masks'
  },
)

document.querySelector('#auto-attach')!.addEventListener('submit', async (event) => {
  event.preventDefault()
  const masks: string[] = []
  for (const line of masksInput.value.split(/\r?\n/)) {
    if (!line.trim()) continue
    const mask = normalizeAutoAttachMask(line)
    if (!mask) {
      masksStatus.textContent = ' Enter an HTTP or HTTPS URL with an optional trailing *'
      return
    }
    if (!masks.includes(mask)) masks.push(mask)
  }
  masksSaveButton.disabled = true
  try {
    const result = await chrome.runtime.sendMessage({
      action: 'saveAutoAttachSettings',
      settings: { masks, remember: rememberInput.checked },
    })
    if (!result?.saved) throw new Error('Could not save URL masks')
    masksInput.value = masks.join('\n')
    masksStatus.textContent = ' Saved'
  } catch {
    masksStatus.textContent = ' Could not save URL masks'
  } finally {
    masksSaveButton.disabled = false
  }
})
