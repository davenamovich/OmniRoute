class Database {
  constructor() {}
  prepare() {
    return {
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
      get: () => undefined,
      all: () => [],
    };
  }
  exec() {}
  pragma() {}
  transaction(fn) {
    return fn;
  }
  backup() {
    return Promise.resolve({});
  }
  close() {}
}

module.exports = Database;
