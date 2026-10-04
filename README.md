# NH-Quest-Editor

The GT New Horizons questbook in the browser, recreated from BetterQuesting's own GUI code and
textures. Quests come straight from the modpack's `master` branch; item names and icons come
from a headless export of the latest GTNH daily build.

Planned next: NEI-style recipe views, then editing quests in the browser and exporting the
changes as a pull request.

## Layout

```
site/        the website (TypeScript + Vite, no framework; the GUI is drawn on a <canvas>)
  src/gui/       port of BetterQuesting's GUI toolkit: themes, panels, Minecraft font
  src/screens/   questbook screens: quest lines, quest, search, properties, settings
  scripts/       data build steps (quests, items, vanilla font)
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

# Minecraft's font, downloaded from Mojang (not stored in this repository)
npm run data:vanilla

# Optional: item names and icons, from the files in the "game-data" release
npm run data:items -- path/to/export.json path/to/icons public/data/questbook.json

npm run dev
```

Without item data the questbook still works; items show their registry names and a placeholder.

## Credits

- GUI textures, theme definitions and translations in `site/public/assets/betterquesting` and
  `site/public/assets/bq_standard` are from [BetterQuesting](https://github.com/GTNewHorizons/BetterQuesting)
  (MIT, see the LICENSE files there).
- The exporter is based on gtnh-calc-oracle from
  [gtnh-factory-flow](https://github.com/jackwrichards/gtnh-factory-flow) (MIT); see `exporter/README.md`.
- Minecraft assets belong to Mojang and are downloaded at build time.
