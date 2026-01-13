import bcrypt from "bcryptjs";

async function main() {
  const password = process.argv[2];
  const rounds = Number(process.argv[3] ?? "12");

  if (!password) {
    console.error('Usage: npx tsx scripts/hash-password.ts "NewPass@12345" 12');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, rounds);
  console.log(hash);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
