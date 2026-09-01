import { assert } from "chai";
import type { Entry } from "rmapi-js";
import { identityTag } from "../src/modules/sync/dedupe";
import { isUntrackedPdf } from "../src/modules/sync/importUntracked";

const FOLDER = "folder-zotero";

function pdf(
  id: string,
  opts: {
    parent?: string;
    tags?: Entry["tags"];
    fileType?: "pdf" | "epub" | "notebook";
    visibleName?: string;
  } = {},
): Entry {
  return {
    type: "DocumentType",
    id,
    hash: `hash-${id}`,
    visibleName: opts.visibleName ?? id,
    lastModified: "0",
    pinned: false,
    lastOpened: "",
    fileType: opts.fileType ?? "pdf",
    parent: opts.parent ?? FOLDER,
    tags: opts.tags,
  };
}

function folder(id: string): Entry {
  return {
    type: "CollectionType",
    id,
    hash: `hash-${id}`,
    visibleName: id,
    lastModified: "0",
    pinned: false,
    parent: "",
  };
}

describe("isUntrackedPdf", function () {
  const none = new Set<string>();

  it("includes a genuinely new, untagged PDF in the folder", function () {
    assert.isTrue(isUntrackedPdf(pdf("a"), FOLDER, none));
  });

  it("excludes non-DocumentType entries", function () {
    assert.isFalse(isUntrackedPdf(folder("col"), FOLDER, none));
  });

  it("excludes non-PDF documents", function () {
    assert.isFalse(
      isUntrackedPdf(pdf("epub", { fileType: "epub" }), FOLDER, none),
    );
    assert.isFalse(
      isUntrackedPdf(pdf("nb", { fileType: "notebook" }), FOLDER, none),
    );
  });

  it("excludes entries outside the configured folder", function () {
    assert.isFalse(
      isUntrackedPdf(pdf("a", { parent: "other-folder" }), FOLDER, none),
    );
    assert.isFalse(isUntrackedPdf(pdf("root", { parent: "" }), FOLDER, none));
    assert.isFalse(
      isUntrackedPdf(pdf("trashed", { parent: "trash" }), FOLDER, none),
    );
  });

  it("treats missing parent as root (empty folder id)", function () {
    const atRoot = pdf("rootless");
    delete (atRoot as { parent?: string }).parent;
    assert.isTrue(isUntrackedPdf(atRoot, "", none));
    assert.isFalse(isUntrackedPdf(atRoot, FOLDER, none));
  });

  it("excludes entries already present in local records", function () {
    assert.isFalse(
      isUntrackedPdf(pdf("tracked"), FOLDER, new Set(["tracked"])),
    );
  });

  it("excludes entries carrying any zrs-id-* tag", function () {
    const tagged = pdf("claimed", {
      tags: [identityTag(1, "ITEMKEY1")],
    });
    assert.isFalse(isUntrackedPdf(tagged, FOLDER, none));
    const mixed = pdf("claimed2", {
      tags: ["highlights", { name: identityTag(2, "KEY2"), timestamp: 1 }],
    });
    assert.isFalse(isUntrackedPdf(mixed, FOLDER, none));
  });

  it("includes a PDF whose only tags are unrelated", function () {
    const other = pdf("tagged", { tags: ["work", "to-read"] });
    assert.isTrue(isUntrackedPdf(other, FOLDER, none));
  });
});
