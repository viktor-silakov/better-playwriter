---
'better-playwriter': patch
---

1. **An action or a wait gives up after 15 seconds at most,** also under a long execute timeout. Before, a wrong locator could wait 60 seconds. Pass `timeout` to the action for slow content.
2. **The scrolling-list note finds a scroller inside the list and counts rows:** `listbox "Rows" has 7 of about 310 rows in the page`.
3. **A call log masks long attribute values** of the elements it quotes.
4. **Skill: a recipe to click and read the pane that changes.**
