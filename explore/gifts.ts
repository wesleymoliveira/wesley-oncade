// Gifts belong to the partner path, where the platform funds claim links on
// chain. This project never does that, so only the refusals are asked for:
// nothing here can create or fund a gift.

import { addresses } from '../scripts/lib/addresses.ts';
import { brief, explore } from './lib.ts';

const x = explore('gifts');
const { team } = addresses();
const fakeHash = `0x${'ab'.repeat(32)}`;

const payout = await x.call(
  'a payout paid from the dashboard',
  'POST /distributions',
  {},
  {
    body: {
      mode: 'fixed',
      totalAmountCents: 600,
      payoutPath: 'dashboard',
      memo: `Exploration ${x.tag} gifts`,
      recipients: team.map((email, i) => ({ email, name: `Person ${i + 1}`, amount: i + 1 })),
    },
  },
);
const id = String(payout.body?._id);
try {
  const funded = await x.call(
    'mark gifts funded on that payout',
    'POST /gifts/mark-funded',
    {},
    { body: { distributionId: id, giftData: [], transactionHash: fakeHash } },
  );
  const fake = await x.call(
    'mark a gift that does not exist as funded',
    'POST /gifts/mark-funded',
    {},
    {
      body: {
        distributionId: id,
        giftData: [{ giftId: 'gift_does_not_exist', claimCode: 'ab'.repeat(32) }],
        transactionHash: fakeHash,
      },
    },
  );
  const nothing = await x.call('mark gifts funded with nothing in it', 'POST /gifts/mark-funded', {}, { body: {} });
  const bulkEmpty = await x.call(
    'bulk gifts with no recipients',
    'POST /gifts/bulk',
    {},
    { body: { distributionId: id, recipients: [] } },
  );
  x.answer(
    'wrong payout path',
    `gifts/mark-funded on a dashboard payout: no gifts ${brief(funded)}, a gift that does not exist ${brief(fake)}; ` +
      `with an empty body ${brief(nothing)}; gifts/bulk with no recipients ${brief(bulkEmpty)}`,
  );
} finally {
  await x.call('clean up', 'POST /distributions/{distributionId}/cancel', { distributionId: id });
}
await x.finish();
