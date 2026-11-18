// The work queue, through the SQS API. A standard queue: delivery is
// at-least-once and unordered, so every consumer must be idempotent.
// A message that fails `queueMaxReceives` times moves to the dead-letter queue.

import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { config } from '../config.ts';

export interface QueueMessage {
  /** Needed to delete or delay this delivery. */
  receipt: string;
  body: string;
  /** W3C trace context of the code that published it. */
  traceparent?: string;
  /** How many times SQS has handed this message out, this delivery included. */
  receiveCount: number;
}

interface QueueUrls {
  work: string;
  deadLetter: string;
}

const client = new SQSClient({
  region: config.queueRegion,
  endpoint: config.queueEndpoint,
  // ElasticMQ ignores credentials; the SDK still wants some.
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});

let urls: Promise<QueueUrls> | undefined;

/** Creates the queue and its dead-letter queue if they are missing. */
export function ensureQueues(): Promise<QueueUrls> {
  urls ??= (async () => {
    const dead = await client.send(new CreateQueueCommand({ QueueName: `${config.queueName}-dlq` }));
    const deadAttrs = await client.send(
      new GetQueueAttributesCommand({ QueueUrl: dead.QueueUrl, AttributeNames: ['QueueArn'] }),
    );
    const work = await client.send(
      new CreateQueueCommand({
        QueueName: config.queueName,
        Attributes: {
          VisibilityTimeout: '30',
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: deadAttrs.Attributes?.QueueArn,
            maxReceiveCount: config.queueMaxReceives,
          }),
        },
      }),
    );
    if (!work.QueueUrl || !dead.QueueUrl) throw new Error('queue creation returned no URL');
    return { work: work.QueueUrl, deadLetter: dead.QueueUrl };
  })();
  return urls;
}

/** `delaySeconds` hides the message for a while: how "try again later" is done. */
export async function publish(body: string, traceparent?: string, delaySeconds = 0): Promise<void> {
  const { work } = await ensureQueues();
  await client.send(
    new SendMessageCommand({
      QueueUrl: work,
      MessageBody: body,
      DelaySeconds: Math.min(900, Math.max(0, Math.round(delaySeconds))),
      MessageAttributes: traceparent ? { traceparent: { DataType: 'String', StringValue: traceparent } } : undefined,
    }),
  );
}

async function receiveFrom(queueUrl: string, waitSeconds: number, max: number): Promise<QueueMessage[]> {
  const out = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: max,
      WaitTimeSeconds: waitSeconds,
      MessageAttributeNames: ['traceparent'],
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    }),
  );
  return (out.Messages ?? []).map((m) => ({
    receipt: m.ReceiptHandle ?? '',
    body: m.Body ?? '',
    traceparent: m.MessageAttributes?.traceparent?.StringValue,
    receiveCount: Number(m.Attributes?.ApproximateReceiveCount ?? 1),
  }));
}

/** Long-polls the work queue. */
export async function receive(waitSeconds = 5, max = 10): Promise<QueueMessage[]> {
  return receiveFrom((await ensureQueues()).work, waitSeconds, max);
}

export async function receiveDeadLetters(max = 10): Promise<QueueMessage[]> {
  return receiveFrom((await ensureQueues()).deadLetter, 0, max);
}

/** Done: remove the message so it is not delivered again. */
export async function ack(message: QueueMessage, from: 'work' | 'deadLetter' = 'work'): Promise<void> {
  const queueUrls = await ensureQueues();
  await client.send(new DeleteMessageCommand({ QueueUrl: queueUrls[from], ReceiptHandle: message.receipt }));
}

/** Not now: hide the message for `seconds`, then let it be delivered again. */
export async function retryLater(message: QueueMessage, seconds: number): Promise<void> {
  const { work } = await ensureQueues();
  await client.send(
    new ChangeMessageVisibilityCommand({ QueueUrl: work, ReceiptHandle: message.receipt, VisibilityTimeout: seconds }),
  );
}

async function depthOf(queueUrl: string): Promise<{ waiting: number; inFlight: number }> {
  const out = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return {
    waiting: Number(out.Attributes?.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(out.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
  };
}

export async function queueDepth(): Promise<{ waiting: number; inFlight: number; deadLetters: number }> {
  const queueUrls = await ensureQueues();
  const [work, dead] = await Promise.all([depthOf(queueUrls.work), depthOf(queueUrls.deadLetter)]);
  return { ...work, deadLetters: dead.waiting };
}
