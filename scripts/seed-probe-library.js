'use strict';

const path = require('node:path');
const { DatabaseClient } = require('../main/database/client');
const { DocumentLibraryService } = require('../main/services/document-library');

async function main() {
  const userDataPath = path.resolve(process.argv[2]);
  const pdfPath = path.resolve(process.argv[3]);
  const client = new DatabaseClient(path.join(userDataPath, 'library.sqlite'), { appVersion: '3.0.0-probe' });
  try {
    await client.start();
    const library = new DocumentLibraryService({ db: client, userDataPath });
    await library.init();
    const document = await library.importFile(pdfPath, { mode: 'reference' });
    console.log(JSON.stringify({ documentId: document.document_id, title: document.title }));
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
