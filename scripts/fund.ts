/**
 * fund.ts — sends 100 ETH from Hardhat account #0 to any address
 * Usage:  npx hardhat run scripts/fund.ts --network localhost
 * Set FUND_TO env var to a comma-separated list of addresses, or edit the array below.
 */
import hre from "hardhat";

async function main() {
  const conn = await hre.network.connect();
  const ethers = conn.ethers;
  const [funder] = await ethers.getSigners();

  // ── Edit these or set FUND_TO env var ────────────────────────────
  const recipients: string[] = process.env.FUND_TO
    ? process.env.FUND_TO.split(",").map((a) => a.trim())
    : [
        // paste your MetaMask addresses here:
        // "0xYourAddress1",
        // "0xYourAddress2",
      ];

  if (recipients.length === 0) {
    console.error("No recipients. Set FUND_TO=0xAddr1,0xAddr2 or edit scripts/fund.ts");
    process.exit(1);
  }

  const amount = ethers.parseEther("100");

  for (const addr of recipients) {
    const tx = await funder.sendTransaction({ to: addr, value: amount });
    await tx.wait();
    const bal = await ethers.provider.getBalance(addr);
    console.log(`Funded ${addr} → 100 ETH  (balance: ${ethers.formatEther(bal)} ETH)`);
  }
}

main().catch(console.error);
