# Payflex on oneX

A responsive Astro course with accessible interactions, persisted learner progress, earned completion, and SCORM 1.2 support for People Connect-compatible LMS delivery.

## Commands

```sh
npm run dev
npm run build
npm run preview
npm run verify
npm run verify:scorm
npm run prepare:scorm
```

The course requires learners to view every section, submit all four knowledge checks, correctly complete the Allowed/Excluded sort, and successfully complete all four Final Challenge decisions. SCORM completion is set only when those requirements are met and the learner selects **Return to People Connect**.

Approved learner copy and interaction answers are stored in `src/data/course.ts`. Course-specific visual assets are stored in `public/assets/payflex`.

The oneX navigation guide and Payflex FAQ are referenced by the approved copy but were not included in the supplied source files. The separately discovered `Payflex.pdf` is a draft QRG containing an unresolved SME publishing note and is therefore not packaged as a learner resource.
