/**
 * Thrown by a step that cannot finish now and is not broken: the provider
 * is busy, the breaker is open, another worker holds the batch. The worker
 * puts a fresh copy of the message back on the queue with a delay, so a
 * wait never counts towards the dead-letter limit. Only real errors do.
 */
export class Later extends Error {
  seconds: number;

  constructor(seconds: number, why: string) {
    super(why);
    this.name = 'Later';
    this.seconds = Math.max(1, Math.round(seconds));
  }
}
