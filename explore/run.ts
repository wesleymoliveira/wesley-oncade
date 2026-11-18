// npm run explore -- <family>     one family of the Platform API, against the test environment
// npm run explore -- campaign-join open | close     the part that needs a second person
const family = process.argv[2];
if (!family || !/^[a-z-]+$/.test(family)) {
  console.error('usage: npm run explore -- <family>   (see the files in explore/)');
  process.exit(1);
}
await import(`./${family}.ts`);

export {};
