import { AsyncLocalStorage } from 'node:async_hooks';

type RequestContextStore = {
  requestId: string;
};

const storage = new AsyncLocalStorage<RequestContextStore>();

export const requestContext = {
  runWithRequestId<T>(requestId: string, callback: () => T): T {
    return storage.run({ requestId }, callback);
  },
  getRequestId(): string | undefined {
    return storage.getStore()?.requestId;
  }
};
