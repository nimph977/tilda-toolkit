import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyListOps, decodeList, diffCards, encodeList } from '../list-model.mjs';
import { cleanText, countByType, splitRecords, zeroSummary } from '../lib/html-blocks.mjs';

test('synthetic standard-list model round-trips and protects its identity fields', () => {
  const cards = decodeList(JSON.stringify({
    0: { lid: '5001', ls: '10', loff: '', li_title: 'First item', li_descr: 'Text', li_img: '' },
    1: { lid: '5002', ls: '20', loff: '', li_title: 'Second item', li_descr: '', li_img: '' },
  }));
  const changed = applyListOps(cards, {
    set: [{ lid: '5001', fields: { li_title: 'Updated item' } }],
    add: [{ fields: { li_title: 'Third item' } }],
    remove: [{ lid: '5002' }],
  }, { now: 9000000000000 });
  assert.deepEqual(changed.cards.map((card) => [card.lid, card.li_title, card.ls]), [
    ['5001', 'Updated item', '10'], ['9000000000000', 'Third item', '20'],
  ]);
  assert.deepEqual(decodeList(encodeList(changed.cards)), changed.cards);
  assert.throws(() => applyListOps(cards, { set: [{ lid: '5001', fields: { lid: 'changed' } }] }), (e) => e.code === 'LID_IMMUTABLE' && e.key === 'list.cardLidImmutable');
  assert.deepEqual(diffCards(changed.cards, changed.cards), []);
});

test('synthetic exported HTML is split into blocks with Zero Block metadata', () => {
  const html = '<div id="rec7001" data-record-type="396"><div class="tn-elem" data-elem-id="9000000000001"></div></div>'
    + '<div id="rec7002" data-record-type="10"><p>Sample</p></div>';
  const blocks = splitRecords(html);
  assert.deepEqual(blocks.map((block) => [block.recid, block.type, block.order]), [['7001', '396', 1], ['7002', '10', 2]]);
  assert.deepEqual(countByType(blocks), [['10', 1], ['396', 1]]);
  assert.deepEqual(zeroSummary(blocks[0]).elemIds, ['9000000000001']);
  assert.equal(cleanText('<style>x</style><p>One&nbsp;<b>two</b> &amp; three</p>'), 'One two & three');
});
