1. Code Quality
   1. Implement Typescript for better type safety.
   2. Add unit tests
   3. Extract constants and config to separate files. For example worker.js:136 and worker.js:317
2. Project architecture
   1. Split worker.js into smaller and focused modules. For example a module only to call hubspot, another for queue.
   2. Implement repository pattern for data access
3. Performance issues
   1. Sequence API calls. You could call `processContacts`, `processCompanies` and `processMeetings` inside a `Promise.all`. Due the time has end it was not implemented and tested
   2. cloneDeep with 2000 items. You could process into small arrays to improve memory efficiency
   3. Queue with too high concurrency