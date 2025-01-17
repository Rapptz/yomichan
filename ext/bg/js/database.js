/*
 * Copyright (C) 2016-2017  Alex Yatskov <alex@foosoft.net>
 * Author: Alex Yatskov <alex@foosoft.net>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */


class Database {
    constructor() {
        this.db = null;
    }

    async prepare() {
        if (this.db) {
            throw new Error('Database already initialized');
        }

        this.db = new Dexie('dict');
        this.db.version(2).stores({
            terms:        '++id,dictionary,expression,reading',
            kanji:        '++,dictionary,character',
            tagMeta:      '++,dictionary',
            dictionaries: '++,title,version'
        });
        this.db.version(3).stores({
            termMeta:  '++,dictionary,expression',
            kanjiMeta: '++,dictionary,character',
            tagMeta:   '++,dictionary,name'
        });
        this.db.version(4).stores({
            terms: '++id,dictionary,expression,reading,sequence'
        });

        await this.db.open();
    }

    async purge() {
        this.validate();

        this.db.close();
        await this.db.delete();
        this.db = null;

        await this.prepare();
    }

    async findTermsBulk(termList, titles) {
        this.validate();

        const promises = [];
        const visited = {};
        const results = [];
        const processRow = (row, index) => {
            if (titles.includes(row.dictionary) && !visited.hasOwnProperty(row.id)) {
                visited[row.id] = true;
                results.push(Database.createTerm(row, index));
            }
        };

        const db = this.db.backendDB();
        const dbTransaction = db.transaction(['terms'], 'readonly');
        const dbTerms = dbTransaction.objectStore('terms');
        const dbIndex1 = dbTerms.index('expression');
        const dbIndex2 = dbTerms.index('reading');

        for (let i = 0; i < termList.length; ++i) {
            const only = IDBKeyRange.only(termList[i]);
            promises.push(
                Database.getAll(dbIndex1, only, i, processRow),
                Database.getAll(dbIndex2, only, i, processRow)
            );
        }

        await Promise.all(promises);

        return results;
    }

    async findTermsExactBulk(termList, readingList, titles) {
        this.validate();

        const promises = [];
        const results = [];
        const processRow = (row, index) => {
            if (row.reading === readingList[index] && titles.includes(row.dictionary)) {
                results.push(Database.createTerm(row, index));
            }
        };

        const db = this.db.backendDB();
        const dbTransaction = db.transaction(['terms'], 'readonly');
        const dbTerms = dbTransaction.objectStore('terms');
        const dbIndex = dbTerms.index('expression');

        for (let i = 0; i < termList.length; ++i) {
            const only = IDBKeyRange.only(termList[i]);
            promises.push(Database.getAll(dbIndex, only, i, processRow));
        }

        await Promise.all(promises);

        return results;
    }

    async findTermsBySequenceBulk(sequenceList, mainDictionary) {
        this.validate();

        const promises = [];
        const results = [];
        const processRow = (row, index) => {
            if (row.dictionary === mainDictionary) {
                results.push(Database.createTerm(row, index));
            }
        };

        const db = this.db.backendDB();
        const dbTransaction = db.transaction(['terms'], 'readonly');
        const dbTerms = dbTransaction.objectStore('terms');
        const dbIndex = dbTerms.index('sequence');

        for (let i = 0; i < sequenceList.length; ++i) {
            const only = IDBKeyRange.only(sequenceList[i]);
            promises.push(Database.getAll(dbIndex, only, i, processRow));
        }

        await Promise.all(promises);

        return results;
    }

    async findTermMetaBulk(termList, titles) {
        return this.findGenericBulk('termMeta', 'expression', termList, titles, Database.createMeta);
    }

    async findKanjiBulk(kanjiList, titles) {
        return this.findGenericBulk('kanji', 'character', kanjiList, titles, Database.createKanji);
    }

    async findKanjiMetaBulk(kanjiList, titles) {
        return this.findGenericBulk('kanjiMeta', 'character', kanjiList, titles, Database.createMeta);
    }

    async findGenericBulk(tableName, indexName, indexValueList, titles, createResult) {
        this.validate();

        const promises = [];
        const results = [];
        const processRow = (row, index) => {
            if (titles.includes(row.dictionary)) {
                results.push(createResult(row, index));
            }
        };

        const db = this.db.backendDB();
        const dbTransaction = db.transaction([tableName], 'readonly');
        const dbTerms = dbTransaction.objectStore(tableName);
        const dbIndex = dbTerms.index(indexName);

        for (let i = 0; i < indexValueList.length; ++i) {
            const only = IDBKeyRange.only(indexValueList[i]);
            promises.push(Database.getAll(dbIndex, only, i, processRow));
        }

        await Promise.all(promises);

        return results;
    }

    async findTagForTitle(name, title) {
        this.validate();

        let result = null;
        const db = this.db.backendDB();
        const dbTransaction = db.transaction(['tagMeta'], 'readonly');
        const dbTerms = dbTransaction.objectStore('tagMeta');
        const dbIndex = dbTerms.index('name');
        const only = IDBKeyRange.only(name);
        await Database.getAll(dbIndex, only, null, row => {
            if (title === row.dictionary) {
                result = row;
            }
        });

        return result;
    }

    async summarize() {
        this.validate();

        return this.db.dictionaries.toArray();
    }

    async importDictionary(archive, progressCallback, exceptions) {
        this.validate();

        const maxTransactionLength = 1000;
        const bulkAdd = async (table, items, total, current) => {
            if (items.length < maxTransactionLength) {
                if (progressCallback) {
                    progressCallback(total, current);
                }

                try {
                    await table.bulkAdd(items);
                } catch (e) {
                    if (exceptions) {
                        exceptions.push(e);
                    } else {
                        throw e;
                    }
                }
            } else {
                for (let i = 0; i < items.length; i += maxTransactionLength) {
                    if (progressCallback) {
                        progressCallback(total, current + i / items.length);
                    }

                    let count = Math.min(maxTransactionLength, items.length - i);
                    try {
                        await table.bulkAdd(items.slice(i, i + count));
                    } catch (e) {
                        if (exceptions) {
                            exceptions.push(e);
                        } else {
                            throw e;
                        }
                    }
                }
            }
        };

        const indexDataLoaded = async summary => {
            if (summary.version > 3) {
                throw new Error('Unsupported dictionary version');
            }

            const count = await this.db.dictionaries.where('title').equals(summary.title).count();
            if (count > 0) {
                throw new Error('Dictionary is already imported');
            }

            await this.db.dictionaries.add(summary);
        };

        const termDataLoaded = async (summary, entries, total, current) => {
            const rows = [];
            if (summary.version === 1) {
                for (const [expression, reading, definitionTags, rules, score, ...glossary] of entries) {
                    rows.push({
                        expression,
                        reading,
                        definitionTags,
                        rules,
                        score,
                        glossary,
                        dictionary: summary.title
                    });
                }
            } else {
                for (const [expression, reading, definitionTags, rules, score, glossary, sequence, termTags] of entries) {
                    rows.push({
                        expression,
                        reading,
                        definitionTags,
                        rules,
                        score,
                        glossary,
                        sequence,
                        termTags,
                        dictionary: summary.title
                    });
                }
            }

            await bulkAdd(this.db.terms, rows, total, current);
        };

        const termMetaDataLoaded = async (summary, entries, total, current) => {
            const rows = [];
            for (const [expression, mode, data] of entries) {
                rows.push({
                    expression,
                    mode,
                    data,
                    dictionary: summary.title
                });
            }

            await bulkAdd(this.db.termMeta, rows, total, current);
        };

        const kanjiDataLoaded = async (summary, entries, total, current)  => {
            const rows = [];
            if (summary.version === 1) {
                for (const [character, onyomi, kunyomi, tags, ...meanings] of entries) {
                    rows.push({
                        character,
                        onyomi,
                        kunyomi,
                        tags,
                        meanings,
                        dictionary: summary.title
                    });
                }
            } else {
                for (const [character, onyomi, kunyomi, tags, meanings, stats] of entries) {
                    rows.push({
                        character,
                        onyomi,
                        kunyomi,
                        tags,
                        meanings,
                        stats,
                        dictionary: summary.title
                    });
                }
            }

            await bulkAdd(this.db.kanji, rows, total, current);
        };

        const kanjiMetaDataLoaded = async (summary, entries, total, current) => {
            const rows = [];
            for (const [character, mode, data] of entries) {
                rows.push({
                    character,
                    mode,
                    data,
                    dictionary: summary.title
                });
            }

            await bulkAdd(this.db.kanjiMeta, rows, total, current);
        };

        const tagDataLoaded = async (summary, entries, total, current) => {
            const rows = [];
            for (const [name, category, order, notes, score] of entries) {
                const row = dictTagSanitize({
                    name,
                    category,
                    order,
                    notes,
                    score,
                    dictionary: summary.title
                });

                rows.push(row);
            }

            await bulkAdd(this.db.tagMeta, rows, total, current);
        };

        return await Database.importDictionaryZip(
            archive,
            indexDataLoaded,
            termDataLoaded,
            termMetaDataLoaded,
            kanjiDataLoaded,
            kanjiMetaDataLoaded,
            tagDataLoaded
        );
    }

    validate() {
        if (this.db === null) {
            throw new Error('Database not initialized');
        }
    }

    static async importDictionaryZip(
        archive,
        indexDataLoaded,
        termDataLoaded,
        termMetaDataLoaded,
        kanjiDataLoaded,
        kanjiMetaDataLoaded,
        tagDataLoaded
    ) {
        const zip = await JSZip.loadAsync(archive);

        const indexFile = zip.files['index.json'];
        if (!indexFile) {
            throw new Error('No dictionary index found in archive');
        }

        const index = JSON.parse(await indexFile.async('string'));
        if (!index.title || !index.revision) {
            throw new Error('Unrecognized dictionary format');
        }

        const summary = {
            title: index.title,
            revision: index.revision,
            sequenced: index.sequenced,
            version: index.format || index.version
        };

        await indexDataLoaded(summary);

        const buildTermBankName      = index => `term_bank_${index + 1}.json`;
        const buildTermMetaBankName  = index => `term_meta_bank_${index + 1}.json`;
        const buildKanjiBankName     = index => `kanji_bank_${index + 1}.json`;
        const buildKanjiMetaBankName = index => `kanji_meta_bank_${index + 1}.json`;
        const buildTagBankName       = index => `tag_bank_${index + 1}.json`;

        const countBanks = namer => {
            let count = 0;
            while (zip.files[namer(count)]) {
                ++count;
            }

            return count;
        };

        const termBankCount      = countBanks(buildTermBankName);
        const termMetaBankCount  = countBanks(buildTermMetaBankName);
        const kanjiBankCount     = countBanks(buildKanjiBankName);
        const kanjiMetaBankCount = countBanks(buildKanjiMetaBankName);
        const tagBankCount       = countBanks(buildTagBankName);

        let bankLoadedCount = 0;
        let bankTotalCount =
            termBankCount +
            termMetaBankCount +
            kanjiBankCount +
            kanjiMetaBankCount +
            tagBankCount;

        if (tagDataLoaded && index.tagMeta) {
            const bank = [];
            for (const name in index.tagMeta) {
                const tag = index.tagMeta[name];
                bank.push([name, tag.category, tag.order, tag.notes, tag.score]);
            }

            tagDataLoaded(summary, bank, ++bankTotalCount, bankLoadedCount++);
        }

        const loadBank = async (summary, namer, count, callback) => {
            if (callback) {
                for (let i = 0; i < count; ++i) {
                    const bankFile = zip.files[namer(i)];
                    const bank = JSON.parse(await bankFile.async('string'));
                    await callback(summary, bank, bankTotalCount, bankLoadedCount++);
                }
            }
        };

        await loadBank(summary, buildTermBankName, termBankCount, termDataLoaded);
        await loadBank(summary, buildTermMetaBankName, termMetaBankCount, termMetaDataLoaded);
        await loadBank(summary, buildKanjiBankName, kanjiBankCount, kanjiDataLoaded);
        await loadBank(summary, buildKanjiMetaBankName, kanjiMetaBankCount, kanjiMetaDataLoaded);
        await loadBank(summary, buildTagBankName, tagBankCount, tagDataLoaded);

        return summary;
    }

    static createTerm(row, index) {
        return {
            index,
            expression: row.expression,
            reading: row.reading,
            definitionTags: dictFieldSplit(row.definitionTags || row.tags || ''),
            termTags: dictFieldSplit(row.termTags || ''),
            rules: dictFieldSplit(row.rules),
            glossary: row.glossary,
            score: row.score,
            dictionary: row.dictionary,
            id: row.id,
            sequence: typeof row.sequence === 'undefined' ? -1 : row.sequence
        };
    }

    static createKanji(row, index) {
        return {
            index,
            character: row.character,
            onyomi: dictFieldSplit(row.onyomi),
            kunyomi: dictFieldSplit(row.kunyomi),
            tags: dictFieldSplit(row.tags),
            glossary: row.meanings,
            stats: row.stats,
            dictionary: row.dictionary
        };
    }

    static createMeta(row, index) {
        return {
            index,
            mode: row.mode,
            data: row.data,
            dictionary: row.dictionary
        };
    }

    static getAll(dbIndex, query, context, processRow) {
        const fn = typeof dbIndex.getAll === 'function' ? Database.getAllFast : Database.getAllUsingCursor;
        return fn(dbIndex, query, context, processRow);
    }

    static getAllFast(dbIndex, query, context, processRow) {
        return new Promise((resolve, reject) => {
            const request = dbIndex.getAll(query);
            request.onerror = (e) => reject(e);
            request.onsuccess = (e) => {
                for (const row of e.target.result) {
                    processRow(row, context);
                }
                resolve();
            };
        });
    }

    static getAllUsingCursor(dbIndex, query, context, processRow) {
        return new Promise((resolve, reject) => {
            const request = dbIndex.openCursor(query, 'next');
            request.onerror = (e) => reject(e);
            request.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    processRow(cursor.value, context);
                    cursor.continue();
                } else {
                    resolve();
                }
            };
        });
    }
}
