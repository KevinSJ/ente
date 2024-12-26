import { assertionFailed } from "@/base/assert";
import { newID } from "@/base/id";
import { ensureLocalUser } from "@/base/local-user";
import type { EnteFile } from "@/media/file";
import { metadataHash } from "@/media/file-metadata";
import { getPublicMagicMetadataSync } from "@ente/shared/file-metadata";
import {
    addToCollection,
    createCollectionNameByID,
    moveToTrash,
} from "./collection";
import { getLocalCollections } from "./collections";
import { getLocalFiles } from "./files";
import { syncFilesAndCollections } from "./sync";

/**
 * A group of duplicates as shown in the UI.
 */
export interface DuplicateGroup {
    /**
     * A nanoid for this group.
     *
     * This can be used as the key when rendering the group in a list.
     */
    id: string;
    /**
     * Files which our algorithm has determined to be duplicates of each other.
     *
     * These are sorted by the collectionName.
     */
    items: {
        /**
         * The underlying file to delete.
         *
         * This is one of the files from amongst {@link collectionFiles},
         * arbitrarily picked to stand in for the entire set of files in the UI.
         */
        file: EnteFile;
        /**
         * All the collection files for the underlying file.
         *
         * This includes {@link file} too.
         */
        collectionFiles: EnteFile[];
        /**
         * The name of the collection to which {@link file} belongs.
         *
         * Like {@link file} itself, this is an arbitrary pick. Logically, none
         * of the collections to which the file belongs are given more
         * preference than the other.
         */
        collectionName: string;
    }[];
    /**
     * The size (in bytes) of each item in the group.
     */
    itemSize: number;
    /**
     * The number of files that will be pruned if the user decides to dedup this
     * group.
     */
    prunableCount: number;
    /**
     * The size (in bytes) that can be saved if the user decides to dedup this
     * group.
     */
    prunableSize: number;
    /**
     * `true` if the user has marked this group for deduping.
     */
    isSelected: boolean;
}

/**
 * Find exact duplicates in the user's library, and return them in groups that
 * can then be deduped keeping only one entry in each group.
 *
 * [Note: Deduplication logic]
 *
 * Detecting duplicates:
 *
 * 1. Identify and divide files into multiple groups based on hash.
 *
 * 2. By default select all group, with option to unselect individual groups or
 *    all groups.
 *
 * Pruning duplicates:
 *
 * When user presses the dedup button with some selected groups,
 *
 * 1. Identify and select the file which we don't want to delete (preferring
 *    file with caption or edited time).
 *
 * 2. For the remaining files identify the collection owned by the user in which
 *    the remaining files are present.
 *
 * 3. Add the file that we don't plan to delete to such collections as a
 *    symlink.
 *
 * 4. Delete the remaining files.
 */
export const deduceDuplicates = async () => {
    // Find the user's ID.
    const userID = ensureLocalUser().id;

    // Find all non-hidden collections owned by the user, and also use that to
    // keep a map of their names (we'll attach this info to the result later).
    const nonHiddenCollections = await getLocalCollections("normal");
    const nonHiddenOwnedCollections = nonHiddenCollections.filter(
        ({ owner }) => owner.id == userID,
    );
    const allowedCollectionIDs = new Set(
        nonHiddenOwnedCollections.map(({ id }) => id),
    );
    const collectionNameByID = createCollectionNameByID(
        nonHiddenOwnedCollections,
    );

    // Final all non-hidden collection files owned by the user that are in a
    // non-hidden owned collection.
    const nonHiddenCollectionFiles = await getLocalFiles("normal");
    const filteredCollectionFiles = nonHiddenCollectionFiles.filter((f) =>
        allowedCollectionIDs.has(f.collectionID),
    );

    // Group the filtered collection files by their hashes, keeping only one
    // entry per file ID. We also retain all the collections files for a
    // particular file ID.
    const collectionFilesByFileID = new Map<number, EnteFile[]>();
    const filesByHash = new Map<string, EnteFile[]>();
    for (const file of filteredCollectionFiles) {
        const hash = metadataHash(file.metadata);
        if (!hash) {
            // Some very old files uploaded by ancient versions of Ente might
            // not have hashes. Ignore these.
            continue;
        }

        const collectionFiles = collectionFilesByFileID.get(file.id);
        if (!collectionFiles) {
            // This is the first collection file we're seeing for a particular
            // file ID, so also create an entry in the filesByHash map.
            filesByHash.set(hash, [...(filesByHash.get(hash) ?? []), file]);
        }
        collectionFilesByFileID.set(file.id, [
            ...(collectionFiles ?? []),
            file,
        ]);
    }

    // Construct the results from groups that have more than one file with the
    // same hash.
    const duplicateGroups: DuplicateGroup[] = [];

    for (const duplicates of filesByHash.values()) {
        if (duplicates.length < 2) continue;

        // Take the size of any of the items, they should all be the same since
        // the hashes are the same.
        //
        // Note that this is not guaranteed in the case of live photos, since
        // the hash originates from the image and video contents, but the size
        // comes from the size of their combined zip, and different clients
        // might use different zip implementation to arrive at non-exact but
        // similar sizes. The delta should be minor so we can use any of the
        // sizes, this is only meant as a rough UI hint anyway.
        let size = 0;
        for (const file of duplicates) {
            if (file.info?.fileSize) {
                size = file.info.fileSize;
                break;
            }
        }

        // If none of the files marked as duplicates have a size, ignored this
        // group. This shouldn't really happen in practice, but it can happen in
        // rare cases (group of duplicates uploaded by ancient version of Ente
        // which did not attach the file size during uploads).
        if (!size) continue;

        const items = duplicates
            .map((file) => {
                const collectionName = collectionNameByID.get(
                    file.collectionID,
                );
                const collectionFiles = collectionFilesByFileID.get(file.id);
                // Ignore duplicates for which we do not have a collection. This
                // shouldn't really happen though, so retain an assert.
                if (!collectionName || !collectionFiles) {
                    assertionFailed();
                    return undefined;
                }

                return { file, collectionFiles, collectionName };
            })
            .filter((item) => !!item);
        if (items.length < 2) continue;

        // Within each duplicate group, keep the files sorted by collection name
        // so that it is easier to scan them at glance.
        items.sort((a, b) => a.collectionName.localeCompare(b.collectionName));

        duplicateGroups.push({
            id: newID("dg_"),
            items,
            itemSize: size,
            prunableCount: items.length - 1,
            prunableSize: size * (items.length - 1),
            isSelected: true,
        });
    }

    return duplicateGroups;
};

/**
 * Remove duplicate groups that the user has retained from those that we
 * returned in {@link deduceDuplicates}.
 *
 * @param duplicateGroups A list of duplicate groups. This is the same list as
 * would've been returned from a previous call to {@link deduceDuplicates},
 * except (a) their sort order might've changed, and (b) the user may have
 * unselected some of them (i.e. isSelected for such items would be `false`).
 *
 * This function will only process entries for which isSelected is `true`.
 *
 * @param onProgress A function that is called with an estimated progress
 * percentage of the operation (a number between 0 and 100).
 *
 * @returns A set containing the IDs of the duplicate groups that were removed.
 */
export const removeSelectedDuplicateGroups = async (
    duplicateGroups: DuplicateGroup[],
    onProgress: (progress: number) => void,
) => {
    const selectedDuplicateGroups = duplicateGroups.filter((g) => g.isSelected);

    // See: "Pruning duplicates" under [Note: Deduplication logic]. A tl;dr; is
    //
    // 1. For each selected duplicate group, determine the file to retain.
    // 2. Add these to the user owned collections the other files exist in.
    // 3. Delete the other files.
    //

    const filesToAdd = new Map<number, EnteFile[]>();
    let filesToTrash: EnteFile[] = [];

    for (const duplicateGroup of selectedDuplicateGroups) {
        const retainedItem = duplicateGroupItemToRetain(duplicateGroup);
        // Find the existing collection IDs to which this item already belongs.
        const existingCollectionIDs = new Set(
            retainedItem.collectionFiles.map((cf) => cf.collectionID),
        );
        // For each item,
        for (const item of duplicateGroup.items) {
            // except the one we're retaining,
            if (item.file.id == retainedItem.file.id) continue;
            // Add the file we're retaining to each collection to which this
            // item belongs.
            for (const { collectionID } of item.collectionFiles) {
                // Skip if already there
                if (existingCollectionIDs.has(collectionID)) continue;
                filesToAdd.set(collectionID, [
                    ...(filesToAdd.get(collectionID) ?? []),
                    retainedItem.file,
                ]);
            }
            // Add it to the list of items to be trashed.
            filesToTrash = filesToTrash.concat(item.collectionFiles);
        }
    }

    let np = 0;
    const ntotal = filesToAdd.size + filesToTrash.length ? 1 : 0 + /* sync */ 1;
    const tickProgress = () => onProgress((np++ / ntotal) * 100);

    // Process the adds.
    const collections = await getLocalCollections("normal");
    const collectionsByID = new Map(collections.map((c) => [c.id, c]));
    for (const [collectionID, collectionFiles] of filesToAdd.entries()) {
        await addToCollection(
            collectionsByID.get(collectionID)!,
            collectionFiles,
        );
        tickProgress();
    }

    // Process the removes.
    if (filesToTrash.length) {
        await moveToTrash(filesToTrash);
        tickProgress();
    }

    await syncFilesAndCollections();
    tickProgress();

    return new Set(selectedDuplicateGroups.map((g) => g.id));
};

/**
 * Find the most eligible item from amongst the duplicates to retain.
 *
 * Give preference to files which have a caption or edited name or edited time,
 * otherwise pick arbitrarily.
 */
const duplicateGroupItemToRetain = (duplicateGroup: DuplicateGroup) => {
    const itemsWithCaption: DuplicateGroup["items"] = [];
    const itemsWithOtherEdits: DuplicateGroup["items"] = [];
    for (const item of duplicateGroup.items) {
        const pubMM = getPublicMagicMetadataSync(item.file);
        if (!pubMM) continue;
        if (pubMM.caption) itemsWithCaption.push(item);
        if (pubMM.editedName ?? pubMM.editedTime)
            itemsWithOtherEdits.push(item);
    }

    // Duplicate group items should not be empty, so we'll get something always.
    return (
        itemsWithCaption[0] ??
        itemsWithOtherEdits[0] ??
        duplicateGroup.items[0]!
    );
};
