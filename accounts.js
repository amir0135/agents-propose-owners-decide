export class Accounts {
  #accounts = new Map();

  create(id, personalData) {
    if (this.#accounts.has(id)) throw new Error("Account already exists");
    this.#accounts.set(id, { personalData: structuredClone(personalData), deletedAt: null });
  }

  delete(id, day) {
    const account = this.#accounts.get(id);
    if (!account) throw new Error("Account not found");
    if (account.deletedAt === null) account.deletedAt = day;
  }

  purge(day) {
    for (const [id, account] of this.#accounts) {
      if (account.deletedAt !== null && day - account.deletedAt >= 30) {
        this.#accounts.delete(id);
      }
    }
  }

  restore(id, day) {
    this.purge(day);
    const account = this.#accounts.get(id);
    if (!account) throw new Error("Account data has been deleted");
    account.deletedAt = null;
    return structuredClone(account.personalData);
  }

  snapshot(day) {
    this.purge(day);
    return structuredClone([...this.#accounts.values()]);
  }
}
