# solo-ledger

Personal double-entry expense ledger: a mobile PWA posts balanced journal rows
into the user's own Google Spreadsheet, which is the only datastore.

## Tutorials

- [Add a credit card (or any real account)](docs/tutorials/add-a-credit-card.md)

## Install

```sh
npm install
```

## Test

```sh
npm test
```

Run `python3 scripts/gen-fixture.py` from the repository root to regenerate the
Python-source-of-truth byte-parity fixture.

## Credits

App icon derived from Twemoji (https://github.com/jdecked/twemoji), licensed under CC-BY 4.0.
