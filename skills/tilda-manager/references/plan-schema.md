# Operations plan schema

A plan is applied by the cycle `snapshot` → `preview` → `apply` → `verify`; the cycle itself is described in
[../SKILL.md](../SKILL.md), section "Editing a page".

A plan contains `page` and a non-empty `ops` array. Each operation has exactly one kind:
`set`, `field`, `listSet`, `blockSet`, `blockHidden`, `duplicateElement`,
`removeElement`, `gallerySet`, `moveBlock`, `setOrder`, `addZero`, `addRecord` or
`newRecord`.

An ordinary edit of a Zero Block element uses the block address and an element selector:

```json
{
  "name": "text-correction",
  "page": "200002",
  "ops": [
    {
      "block": { "recordid": "9000000000001" },
      "elem": { "elem_id": "9000000000011" },
      "set": { "text": "New text" }
    }
  ]
}
```

`block` is given as `recordid` or `zeroIndex`; `set`, `duplicateElement`,
`removeElement` and `gallerySet` need `elem`. The `field` operation uses
`field: { "name": "...", "value": "..." }`; it applies to an ordinary block.
A full example with synthetic IDs: [../../../examples/basic-text-edit.json](../../../examples/basic-text-edit.json).
An example of a `newRecord` operation from a reference build:
[../../../examples/reference-new-record.json](../../../examples/reference-new-record.json).

Do not copy the example into a working plan without replacing all IDs with data of your own project.
The preview does not replace a visual check in the editor.

## Reason items: `code` and `reason`

`reference plan` does not write into the plan what it could not transfer; it returns it in its result
(`--json`) as two lists: `skipped` (a whole block was skipped) and `unmapped` (a single field, link, image or
card was not transferred). `reference plan --update` returns `unmapped` in the same way. Each item has
the position and template (`order`, `tplid`), sometimes `field`, `card` and `text` (a fragment of the source),
and two fields that explain the omission:

- `code` — a stable machine name of the reason (for example `zeroBlock`), independent of the CLI language.
  Branch on it in scenarios;
- `reason` — the same reason as English text for a human; it is not a language-dependent CLI message, but
  its wording may change, so do not compare it.

The list of codes is not duplicated here; the source is the constants in `scripts/reference-plan.mjs`
(`SKIP_REASONS`, `FIELD_REASONS`, `LINK_REASONS` (imported from `scripts/lib/reference-links.mjs`),
`BUTTON_REASONS`, `VIDEO_REASONS`, `CARD_REASONS`, `MENU_REASONS`, `SOCLINKS_REASONS`, `STYLE_REASONS`,
`SHAPE_REASONS`, `CODE_REASONS`, `FORM_REASONS`, `SETTINGS_REASONS`), `UPDATE_REASONS` in
`scripts/lib/plan-update.mjs` and `LINK_REWRITE_REASONS` in `scripts/donor-links.mjs`. The `donor links` command
prints the links it left as lines `<recordid>.<field>: <reason>`; the codes of those reasons are
`noPage`, `form` and `otherHost`.

For formats of the other operations and their limits read
[operations.md](operations.md) only when the task needs such an operation.
