import { assert } from "chai";
import type { Entry, RemarkableApi } from "rmapi-js";
import {
  identityTag,
  fingerprintTag,
  tagNames,
  hasTag,
  findByIdentity,
  findDuplicateGroups,
  reconcileDuplicates,
} from "../src/modules/sync/dedupe";

function pdf(
  id: string,
  opts: {
    hash?: string;
    lastModified?: string;
    tags?: Entry["tags"];
    visibleName?: string;
  } = {},
): Entry {
  return {
    type: "DocumentType",
    id,
    hash: opts.hash ?? `hash-${id}`,
    visibleName: opts.visibleName ?? id,
    lastModified: opts.lastModified ?? "0",
    pinned: false,
    lastOpened: "",
    fileType: "pdf",
    tags: opts.tags,
  };
}

describe("dedupe tags", function () {
  it("builds a stable identity tag from libraryID + item key", function () {
    assert.equal(identityTag(1, "ABCD1234"), "zrs-id-1-ABCD1234");
    assert.equal(identityTag(2, "ZZZZZZZZ"), "zrs-id-2-ZZZZZZZZ");
  });

  it("truncates a sha-256 hex to a 12-char fingerprint tag", function () {
    const hash = "abcdef0123456789deadbeefcafebabe";
    assert.equal(fingerprintTag(hash), "zrs-fp-abcdef012345");
    assert.equal(fingerprintTag("short"), "zrs-fp-short");
  });

  it("reads tag names from both string tags and {name,timestamp} tags", function () {
    const mixed = pdf("a", {
      tags: ["plain", { name: "structured", timestamp: 1 }],
    });
    assert.deepEqual(tagNames(mixed), ["plain", "structured"]);
    assert.isTrue(hasTag(mixed, "plain"));
    assert.isTrue(hasTag(mixed, "structured"));
    assert.isFalse(hasTag(mixed, "missing"));
    assert.deepEqual(tagNames(pdf("b")), []);
  });

  it("finds the first entry carrying an identity tag", function () {
    const id = identityTag(1, "ITEMKEY1");
    const entries = [
      pdf("other", { tags: ["unrelated"] }),
      pdf("hit", { tags: [id, fingerprintTag("aaa")] }),
      pdf("also", { tags: [id] }),
    ];
    const found = findByIdentity(entries, id);
    assert.equal(found?.id, "hit");
    assert.isUndefined(findByIdentity(entries, identityTag(1, "NOPE")));
  });
});

describe("findDuplicateGroups", function () {
  it("returns nothing when each identity tag appears once", function () {
    const entries = [
      pdf("a", { tags: [identityTag(1, "AAAA")] }),
      pdf("b", { tags: [identityTag(1, "BBBB")] }),
    ];
    assert.deepEqual(findDuplicateGroups(entries), []);
  });

  it("keeps the newest lastModified and lists the rest as dupes", function () {
    const id = identityTag(1, "ITEMKEY1");
    const old = pdf("old", { lastModified: "1000", tags: [id] });
    const mid = pdf("mid", { lastModified: "2000", tags: [id] });
    const newest = pdf("new", { lastModified: "3000", tags: [id] });
    const groups = findDuplicateGroups([old, newest, mid]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].idTag, id);
    assert.equal(groups[0].keep.id, "new");
    assert.deepEqual(
      groups[0].dupes.map((e) => e.id),
      ["mid", "old"],
    );
  });

  it("parses ISO lastModified as well as epoch-ms strings", function () {
    const id = identityTag(1, "ITEMKEY1");
    const iso = pdf("iso", {
      lastModified: "2020-01-01T00:00:00.000Z",
      tags: [id],
    });
    const epoch = pdf("epoch", {
      lastModified: "1700000000000",
      tags: [id],
    });
    const groups = findDuplicateGroups([iso, epoch]);
    assert.equal(groups[0].keep.id, "epoch");
    assert.deepEqual(
      groups[0].dupes.map((e) => e.id),
      ["iso"],
    );
  });

  it("ignores collections even if they carry a zrs-id tag", function () {
    const id = identityTag(1, "ITEMKEY1");
    const folder: Entry = {
      type: "CollectionType",
      id: "folder",
      hash: "h",
      visibleName: "folder",
      lastModified: "9999",
      pinned: false,
      tags: [id],
    };
    const doc = pdf("doc", { lastModified: "1", tags: [id] });
    assert.deepEqual(findDuplicateGroups([folder, doc]), []);
  });

  it("groups independently per identity tag", function () {
    const a = identityTag(1, "AAAA");
    const b = identityTag(1, "BBBB");
    const groups = findDuplicateGroups([
      pdf("a1", { lastModified: "1", tags: [a] }),
      pdf("a2", { lastModified: "2", tags: [a] }),
      pdf("b1", { lastModified: "1", tags: [b] }),
      pdf("b2", { lastModified: "9", tags: [b] }),
    ]);
    assert.equal(groups.length, 2);
    const byTag = Object.fromEntries(groups.map((g) => [g.idTag, g]));
    assert.equal(byTag[a].keep.id, "a2");
    assert.equal(byTag[b].keep.id, "b2");
  });
});

describe("reconcileDuplicates", function () {
  it("deletes older copies and returns the listing without them", async function () {
    const id = identityTag(1, "ITEMKEY1");
    const old = pdf("old", { lastModified: "1000", hash: "h-old", tags: [id] });
    const keep = pdf("keep", {
      lastModified: "2000",
      hash: "h-keep",
      tags: [id],
    });
    const unrelated = pdf("other", {
      tags: [identityTag(1, "OTHER")],
    });
    const deleted: string[] = [];
    const api = {
      delete: async (hash: string) => {
        deleted.push(hash);
        return { hash };
      },
    } as unknown as RemarkableApi;

    const remaining = await reconcileDuplicates(api, [old, keep, unrelated]);
    assert.deepEqual(deleted, ["h-old"]);
    assert.deepEqual(
      remaining.map((e) => e.id),
      ["keep", "other"],
    );
  });

  it("is a no-op when there are no duplicate identity tags", async function () {
    const entries = [
      pdf("a", { tags: [identityTag(1, "AAAA")] }),
      pdf("b", { tags: [identityTag(1, "BBBB")] }),
    ];
    const api = {
      delete: async () => {
        throw new Error("should not delete");
      },
    } as unknown as RemarkableApi;
    const remaining = await reconcileDuplicates(api, entries);
    assert.strictEqual(remaining, entries);
  });
});
