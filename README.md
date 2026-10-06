# NH-Quest-Editor

The GT New Horizons questbook in the browser, recreated from BetterQuesting's own GUI code and
textures. Quests come straight from the modpack's `master` branch; item names, icons and
recipes come from a headless export of the latest GTNH daily build.

Click any item in a quest to see its recipes in an NEI-style window (right click for its uses).
Crafting, smelting and all GregTech recipe maps are shown so far.

Planned next: more recipe handlers and an item list, then editing quests in the browser and
exporting the changes as a pull request.

## Layout

```
site/        the website (TypeScript + Vite, no framework; the GUI is drawn on a <canvas>)
  src/gui/       port of BetterQuesting's GUI toolkit: themes, panels, Minecraft font
  src/screens/   questbook screens: quest lines, quest, search, properties, settings
  src/nei/       NEI's recipe window and its handlers (crafting, smelting, GregTech)
  scripts/       data build steps (quests, items, recipes, vanilla assets)
exporter/    Forge 1.7.10 mod that exports items, icons and recipes from a running client
.github/workflows/
  export.yml     runs a daily build headless with the exporter, publishes the "game-data" release
  site.yml       builds the site from modpack master + game data and deploys GitHub Pages
```

## Working on the site

Needs Node 22.18 or newer.

```sh
cd site
npm install

# Quest data from a checkout of GT-New-Horizons-Modpack
npm run data:quests -- ../../GT-New-Horizons-Modpack/config/betterquesting/DefaultQuests

# Minecraft's font and a few GUI textures, downloaded from Mojang (not stored in this repository)
npm run data:vanilla

# Optional: item names and icons, from the files in the "game-data" release
npm run data:items -- path/to/export.json path/to/icons public/data/questbook.json

# Optional: recipes for the NEI views, from the same files; their GUI textures are in the
# release's gui-textures.tar.gz (unpack it into public/)
npm run data:recipes -- path/to/export.json path/to/icons public/data/nei

npm run dev
```

Without item data the questbook still works; items show their registry names and a placeholder.

## Credits

- GUI textures, theme definitions and translations in `site/public/assets/betterquesting` and
  `site/public/assets/bq_standard` are from [BetterQuesting](https://github.com/GTNewHorizons/BetterQuesting)
  (MIT, see the LICENSE files there).
- The exporter is based on gtnh-calc-oracle from
  [gtnh-factory-flow](https://github.com/jackwrichards/gtnh-factory-flow) (MIT); see `exporter/README.md`.
- The recipe views draw with GUI textures from [NotEnoughItems](https://github.com/GTNewHorizons/NotEnoughItems),
  [GT5-Unofficial](https://github.com/GTNewHorizons/GT5-Unofficial) and
  [ModularUI](https://github.com/GTNewHorizons/ModularUI) (LGPL-3.0). They are taken from the pack's
  jars when the game data is exported and published with it; they are not stored in this repository.
  The recipe window's layout follows NEI's and GregTech's, reimplemented here.
- Minecraft assets belong to Mojang and are downloaded at build time.
