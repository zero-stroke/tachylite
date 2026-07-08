# Tachylite

Light Electron markdown editor/viewer source extracted from the patched local Tachylite install.

## Local workflow

```sh
npm install
npm run check
npm run pack:asar
```

`npm run pack:asar` writes `/tmp/tachylite-app.asar`. To install it locally:

```sh
cp /tmp/tachylite-app.asar /mnt/c/exes/tachylite/resources/app.asar
```
