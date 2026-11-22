/**
 * Express-style synchronous and async middleware pipeline runner.
 *
 * Normal middleware: (req, res, next) => ...  (fn.length < 4)
 * Error middleware:  (err, req, res, next) => ... (fn.length === 4)
 */

/**
 * Execute a list of middleware functions in sequence against (req, res).
 *
 * @param {Function[]} stack
 * @param {object} req
 * @param {object} res
 * @returns {Promise<void>}
 */
export async function runPipeline(stack, req, res) {
  let index = 0;

  async function dispatch(err) {
    if (index >= stack.length) {
      if (err) {
        throw err;
      }
      return;
    }

    const fn = stack[index];
    index += 1;
    const isErrorHandler = fn.length === 4;

    if (err) {
      if (!isErrorHandler) {
        return dispatch(err);
      }
      let nextCalled = false;
      let nextPromise = null;
      const next = (nextErr) => {
        if (nextCalled) return;
        nextCalled = true;
        if (nextErr) {
          // Stop propagating after first error middleware
          nextPromise = Promise.reject(nextErr);
        } else {
          nextPromise = dispatch(null);
        }
      };

      const result = fn(err, req, res, next);
      if (result && typeof result.then === 'function') {
        await result;
      }
      if (nextPromise) {
        await nextPromise;
      }
      return;
    }

    if (isErrorHandler) {
      return dispatch(null);
    }

    let nextCalled = false;
    let nextPromise = null;
    const next = (nextErr) => {
      if (nextCalled) return;
      nextCalled = true;
      nextPromise = dispatch(nextErr || null);
      return nextPromise;
    };

    let result;
    try {
      result = fn(req, res, next);
    } catch (syncErr) {
      return dispatch(syncErr);
    }

    if (result && typeof result.then === 'function') {
      await result;
    }
    if (nextPromise) {
      await nextPromise;
    }
  }

  await dispatch(null);
}
