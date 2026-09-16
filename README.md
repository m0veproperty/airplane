# Aero

Self contained Vercel deployment of the Aerodynamics site capture.

The captured route set is stored in `routes.json`. During `npm run build`, the source pages are fetched once to create the snapshot. CSS, JavaScript, images, fonts, icons, media and other referenced static files are downloaded into `dist` and the generated HTML and CSS are rewritten to use those local files.

The deployed site does not proxy Next.js assets, fonts, images, CSS, JavaScript or the favicon to the Aerodynamics origin. The source domain is used only while producing a fresh build snapshot.

## Deploy

Import this repository into Vercel with the default settings. The repository already defines the build command and output directory.

## Local build

```bash
npm run build
```

To build from another compatible source origin:

```bash
SOURCE_ORIGIN=http://127.0.0.1:4173 npm run build
```

The generated `dist/__capture.json` records the number of routes and local assets captured for that build and confirms that the runtime source proxy is disabled.
