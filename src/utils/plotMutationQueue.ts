/**
 * Serializes Plotly operations that replace or mutate trace arrays.
 *
 * Plotly's APIs return promises but do not serialize calls made by the app.
 * Keeping one recovered tail prevents an older index-based restyle from
 * landing on traces installed by a newer react. A rejected operation is
 * reported and consumed so it cannot poison every later plot update.
 */
export interface PlotMutationQueue {
  current: Promise<void>;
  pending: number;
}

export function enqueuePlotMutation(
  queue: PlotMutationQueue,
  operation: () => void | Promise<void>,
  onError: (error: unknown) => void = (error) => console.error('Plotly mutation failed', error),
): Promise<void> {
  const run = () => {
    try {
      return Promise.resolve(operation());
    } catch (error) {
      return Promise.reject(error);
    }
  };
  // Plotly.react initializes the graph div synchronously before returning its
  // promise. Preserve that first-call behavior so later React effects may
  // safely relayout it; only an already-busy queue defers the next operation.
  // Publish this operation's gate BEFORE invoking it: Plotly can emit events
  // synchronously, and a mutation enqueued by such a handler must wait for the
  // outer promise instead of chaining to the previously-settled tail.
  const startsNow = queue.pending === 0;
  const previous = queue.current;
  queue.pending++;
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  queue.current = gate;
  const task = startsNow ? run() : previous.then(run, run);
  const settled = task.catch((error) => { onError(error); }).finally(() => {
    queue.pending--;
    releaseGate();
  });
  return settled;
}
