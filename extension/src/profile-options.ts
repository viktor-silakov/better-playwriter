export {}

const input = document.querySelector<HTMLInputElement>('#label')!
const status = document.querySelector<HTMLOutputElement>('#status')!

void chrome.storage.local.get('profileLabel').then(({ profileLabel }) => {
  input.value = typeof profileLabel === 'string' ? profileLabel : ''
})
document.querySelector('form')!.addEventListener('submit', (event) => {
  event.preventDefault()
  void chrome.storage.local.set({ profileLabel: input.value.trim() }).then(() => {
    status.textContent = ' Saved'
  })
})
