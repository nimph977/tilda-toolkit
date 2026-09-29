# Схема плана операций

План применяется циклом `snapshot` → `preview` → `apply` → `verify`; сам цикл описан в
[../SKILL.md](../SKILL.md), раздел «Правка страницы».

План содержит `page` и непустой массив `ops`. У каждой операции ровно один вид:
`set`, `field`, `listSet`, `blockSet`, `blockHidden`, `duplicateElement`,
`removeElement`, `gallerySet`, `moveBlock`, `setOrder`, `addZero`, `addRecord` или
`newRecord`.

Обычная правка элемента Zero Block использует адрес блока и селектор элемента:

```json
{
  "name": "text-correction",
  "page": "200002",
  "ops": [
    {
      "block": { "recordid": "9000000000001" },
      "elem": { "elem_id": "9000000000011" },
      "set": { "text": "Новый текст" }
    }
  ]
}
```

`block` задаётся как `recordid` или `zeroIndex`; для `set`, `duplicateElement`,
`removeElement` и `gallerySet` нужен `elem`. Операция `field` использует
`field: { "name": "...", "value": "..." }`; она применима к обычному блоку.
Полный пример с синтетическими ID: [../../../examples/basic-text-edit.json](../../../examples/basic-text-edit.json).
Пример операции `newRecord` из сборки по референсу:
[../../../examples/reference-new-record.json](../../../examples/reference-new-record.json).

Не копируйте пример в рабочий план без замены всех ID на данные своего проекта.
Предпросмотр не заменяет визуальную проверку в редакторе.

Для форматов остальных операций и ограничений читайте
[operations.md](operations.md) только когда задача требует такой операции.
