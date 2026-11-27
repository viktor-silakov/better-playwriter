---
'better-playwriter': patch
---

Labels on `screenshotWithAccessibilityLabels` images now work with `elementForRef`. A label such as `e12` on the image is `@e12` in the snapshot text printed with it and in `elementForRef({ ref: '@e12' })`. Before, the text listed locators without refs, and `elementForRef` answered "Snapshot reference is unavailable" for every label.
