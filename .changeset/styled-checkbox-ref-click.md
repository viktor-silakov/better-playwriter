---
'better-playwriter': patch
---

A click on the ref of a styled checkbox, radio or switch works. Such controls keep the real input under their own drawn mark, so the click waited until it timed out with "intercepts pointer events". The click now goes to the mark when it is the control's own label or sits in the same wrapper.
