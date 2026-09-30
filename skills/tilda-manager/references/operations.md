# Plan operations and limits

Use one operation per `ops` object. A block is addressed by `recordid` or `zeroIndex`;
`set`, `duplicateElement`, `removeElement` and `gallerySet` require an
`elem` selector with one of the fields `elem_id`, `text` or `textIncludes`. The selector must find
exactly one element.

| Operation | Purpose |
| --- | --- |
| `set` | Changes the fields of a Zero Block element. Suits text, geometry, styles, `hidden`, links and an image. |
| `field` | Writes one field of an ordinary block: `{"field":{"name":"...","value":"..."}}`. |
| `listSet` | Changes list cards through `set`, `add`, `remove` or a full replacement of `cards`. |
| `blockSet` | Changes existing scalar service fields of a Zero Block, for example `ab_height`. |
| `blockHidden` | Hides or shows a block with the value `"y"` or `"n"`. |
| `duplicateElement` / `removeElement` | Creates a copy of an element or removes it from the model. |
| `gallerySet` | Changes the slides of the `imgs` gallery through `set`, `add` or `remove`. |
| `moveBlock` / `setOrder` | Changes the order of blocks. For `moveBlock` give `after`, `before` or `index`; `setOrder` holds the whole order of `recordid`. |
| `addZero` / `addRecord` | Creates a block by copying a block of another page. The source is inside the operation in `addZero.source` or `addRecord.source`; `addRecord` needs `tplid`. |
| `newRecord` | Creates a standard block from fields with no source: `{"newRecord":{"tplid":"796","fields":[{"name":"title","value":"…"}],"cards":[…],"images":[{"field":"img","file":"…"}]}}`. Field names come from the `catalog capture` catalog, the fields of both tabs («Контент» (Content) and «Настройки» (Settings)) go in one array; images are uploaded from disk before the write. A Zero Block (`396`) is not built this way. |

`listSet` has the form `{"set":[{"lid":"...","fields":{"li_title":"..."}}]}`;
`index` is allowed instead of `lid`. To add use
`{"add":[{"after":"end","fields":{...}}]}`, to remove -
`{"remove":["<lid>"]}`. `gallerySet` uses the same arrays, but a new slide
must contain `fields.li_img` with a URL `https://static.tildacdn.com/...`.

For `set`, responsive fields are written by `resStrategy`: `scale` by default; `explicit` and `none`
are also available. If you explicitly change a field like `top-res-320`, it is not
recalculated. An image edit applies only to an element of the `image` type and
is passed as `{"image":{"img":"https://...","filewidth":"...","fileheight":"..."}}`.
With both sizes the tool recalculates `height` and its responsive variants from the
element width. The URL may be HTTP(S), but the proven working variant is the Tilda CDN.
`{"image":{"file":"C:/path/image.jpg"}}` is supported only in `apply`: the command
first uploads the file and substitutes `img`, `filewidth`, `fileheight`; such a plan
does not suit `preview` or `--dry-run`.

Example of creating a block:

```json
{
  "page": "200002",
  "ops": [
    {
      "id": "new-zero",
      "addZero": {
        "source": { "page": "200001", "recordid": "9000000000001" }
      }
    },
    {
      "id": "new-record",
      "addRecord": {
        "tplid": "215",
        "source": { "page": "200001", "recordid": "9000000000002" }
      }
    }
  ]
}
```

If all sources are on one page, `source.page` can be given once at the root of the
plan, but `source.recordid` stays nested in each operation. For preparation and
verification, snapshots of the source blocks must exist.

The full `newRecord` schema:

```json
{
  "id": "b3",
  "newRecord": {
    "tplid": "796",
    "fields": [
      { "name": "title", "value": "Heading" },
      { "name": "descr", "value": "First line<br>Second line" },
      { "name": "buttonlink", "value": "https://example.test/" },
      { "name": "margintop", "value": "45px" },
      { "name": "blockbackground", "value": "#ededed" },
      { "name": "title_typo", "value": "{\"color\":\"#ffffff\",\"fontsize\":\"36px\"}" }
    ],
    "cards": [{ "li_title": "Card", "li_descr": "Text", "li_img": "", "li_link": "https://example.test/card" }],
    "images": [
      { "field": "img", "file": "<site folder>/site-reference/demo/images/ab12cd34ef56.jpg" },
      { "card": 0, "field": "li_img", "file": "<site folder>/site-reference/demo/images/cd34ef56ab12.jpg" }
    ]
  },
  "hidden": "n",
  "after": null
}
```

`fields` are the fields of both template tabs, «Контент» (Content) and «Настройки» (Settings), in one array (the list is given by
`catalog capture`; a field that is not in the catalog produces a warning). Block styling is written with the same
fields: the margins `margintop`/`marginbottom` as the string `NNpx`, the background `blockbackground` or `bgcolor`
as `#rrggbb`, typography as the JSON field `<family>_typo` with the keys `color`, `fontsize`,
`fontweight`, `uppercase`, `lineheight`, `widthpx` (the server saves and applies all six;
the derived `<field>_color`, `<field>_fontsize` cannot be written - `saverecord` rejects them or
silently ignores them).

A text field may contain `<br>` - verification treats `<br>`, `<br/>` and `<br />` as equal;
other markup inside a field is not supported. JSON fields (the form's `soclinks` `[{service, link}]`,
the form's `menuitems` `[{title, link, linktarget}]`, `*_typo`) are compared by canonical JSON, so
the server's re-serialization (`\/`, `\uXXXX`, quote entities) gives no mismatch.

`cards` are assembled into the `list` field together with `btitle`
and `bdescr`; `lid` is assigned to the cards automatically. A card may contain `li_link`
if the template stores it (`cardKeys` of the catalog). `images` are uploaded to the Tilda CDN
before the write from files by absolute path (`reference plan` substitutes absolute paths from the reference snapshot): `field` without `card` is an image of a block
field, with `card` - a card image. Verification after the write compares field values and
cards with the plan; a template marked `available: false` in the catalog is rejected before any network call.
`reference plan` builds such operations, but they can also be written by hand. It has two flags
that change the set of fields: `--no-styles` does not transfer styling, and `--substitute <from>=<to>`
builds blocks of one template with another - a workaround for a menu that Tilda does not let you add.

The form fields of a standard block (702, 704 and others) are written with the `forminputs` field - a JSON array
of elements `{li_type, li_nm, li_name, li_ph, li_req, li_title, li_masktype, li_mask}`
(`li_req: "y"` - required; `li_masktype: ""` + `li_mask` - a custom mask); the server keeps them in
`list`, the tool sets `lid` and `ls`, verification goes by `list`. Writing `list` directly does not
help a form: the answer is `OK`, but the list does not change. The success message is `formtitlesuccess`,
`formmsgsuccess`. The redirect address after submitting `formmsgurl` is written only by an operation with the flag
`"formContent": "reference"` (on `newRecord` and `field`); the request recipients (`receivers`,
`receivers_names`) and the Zero Block form model (`inputs`) are never written, the flag does not open them.

An HTML block (`tplid: "131"`) is created by a `newRecord` operation with a `code` field next to `fields`:
`{"newRecord":{"tplid":"131","fields":[],"code":"<div>…</div>"}}`. The code is at most 25 KB and without
`<script` - writing a script resets the Tilda session; `code` on another template is an error before any network call.
Verification compares the code of the re-read block with the plan ignoring whitespace at the edges.

The tool rejects values with `<script` and changes of form fields other than described above.
`listSet` is also rejected for a block that contains form fields. Before reordering blocks take
a fresh inventory: stale data may be rejected. After `addZero` or
`addRecord` use `moveBlock` when the position matters.

The examples above describe the format but do not give permission to write or publish.
