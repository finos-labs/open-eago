const { expect } = require("chai");
const { ethers }  = require("hardhat");

/**
 * Signs a MockMultiSig transaction hash using eth_sign (personal_sign).
 * The contract recovers using MessageHashUtils.toEthSignedMessageHash.
 */
async function signMultiSigTx(signer, multiSig, to, value, data) {
    const nonce   = await multiSig.nonce();
    const txHash  = await multiSig.getTransactionHash(to, value, data, nonce);
    return signer.signMessage(ethers.getBytes(txHash));   // eth_sign
}

describe("MockMultiSig", function () {
    let multiSig;
    let target;        // a contract whose ownership we transfer
    let signerA, signerB, signerC, stranger;

    beforeEach(async function () {
        [signerA, signerB, signerC, stranger] = await ethers.getSigners();
    });

    // ── Constructor ────────────────────────────────────────────────────────────

    describe("constructor", function () {
        it("deploys with 1-of-1 threshold", async function () {
            const MS = await ethers.getContractFactory("MockMultiSig");
            const ms = await MS.deploy([signerA.address], 1n);
            await ms.waitForDeployment();
            expect(await ms.threshold()).to.equal(1n);
            expect(await ms.isSigner(signerA.address)).to.be.true;
        });

        it("deploys with 2-of-3 threshold", async function () {
            const MS = await ethers.getContractFactory("MockMultiSig");
            const ms = await MS.deploy([signerA.address, signerB.address, signerC.address], 2n);
            await ms.waitForDeployment();
            expect(await ms.threshold()).to.equal(2n);
            expect(await ms.getSigners()).to.deep.equal([signerA.address, signerB.address, signerC.address]);
        });

        it("reverts with no signers", async function () {
            const MS = await ethers.getContractFactory("MockMultiSig");
            await expect(MS.deploy([], 1n)).to.be.revertedWith("no signers");
        });

        it("reverts when threshold exceeds signer count", async function () {
            const MS = await ethers.getContractFactory("MockMultiSig");
            await expect(MS.deploy([signerA.address], 2n)).to.be.revertedWith("bad threshold");
        });

        it("reverts on zero threshold", async function () {
            const MS = await ethers.getContractFactory("MockMultiSig");
            await expect(MS.deploy([signerA.address], 0n)).to.be.revertedWith("bad threshold");
        });

        it("reverts on duplicate signer", async function () {
            const MS = await ethers.getContractFactory("MockMultiSig");
            await expect(MS.deploy([signerA.address, signerA.address], 1n))
                .to.be.revertedWith("duplicate signer");
        });
    });

    // ── Single-signer execution ────────────────────────────────────────────────

    describe("1-of-1 executeTransaction", function () {
        beforeEach(async function () {
            const MS = await ethers.getContractFactory("MockMultiSig");
            multiSig = await MS.deploy([signerA.address], 1n);
            await multiSig.waitForDeployment();

            // Deploy ParticipantRegistry owned by multiSig
            const PR = await ethers.getContractFactory("ParticipantRegistry");
            target = await PR.deploy(await multiSig.getAddress());
            await target.waitForDeployment();
        });

        it("executes a transaction with one valid signature", async function () {
            const participantId = ethers.keccak256(ethers.toUtf8Bytes("BANK_A"));
            const data = target.interface.encodeFunctionData("registerParticipant", [
                participantId, 0, 0, [], [], []
            ]);

            const sig = await signMultiSigTx(signerA, multiSig, await target.getAddress(), 0n, data);

            await expect(
                multiSig.executeTransaction(await target.getAddress(), 0n, data, [sig])
            ).to.emit(multiSig, "Executed");

            expect((await target.getParticipant(participantId)).active).to.be.true;
        });

        it("increments nonce after execution", async function () {
            expect(await multiSig.nonce()).to.equal(0n);
            const data = target.interface.encodeFunctionData("registerParticipant", [
                ethers.keccak256(ethers.toUtf8Bytes("B")), 0, 0, [], [], []
            ]);
            const sig = await signMultiSigTx(signerA, multiSig, await target.getAddress(), 0n, data);
            await multiSig.executeTransaction(await target.getAddress(), 0n, data, [sig]);
            expect(await multiSig.nonce()).to.equal(1n);
        });

        it("reverts on replay with old nonce signature", async function () {
            const participantId = ethers.keccak256(ethers.toUtf8Bytes("C"));
            const data = target.interface.encodeFunctionData("registerParticipant", [
                participantId, 0, 0, [], [], []
            ]);
            // Sign at nonce=0
            const sig = await signMultiSigTx(signerA, multiSig, await target.getAddress(), 0n, data);
            // Execute (nonce advances to 1)
            await multiSig.executeTransaction(await target.getAddress(), 0n, data, [sig]);
            // Replay with same sig (now signed for nonce=0, but current nonce=1)
            await expect(
                multiSig.executeTransaction(await target.getAddress(), 0n, data, [sig])
            ).to.be.revertedWith("invalid signer");
        });

        it("reverts when signature is from a non-signer", async function () {
            const data = "0x";
            const sig  = await signMultiSigTx(stranger, multiSig, await target.getAddress(), 0n, data);
            await expect(
                multiSig.executeTransaction(await target.getAddress(), 0n, data, [sig])
            ).to.be.revertedWith("invalid signer");
        });

        it("reverts with insufficient signatures", async function () {
            const data = "0x";
            await expect(
                multiSig.executeTransaction(await target.getAddress(), 0n, data, [])
            ).to.be.revertedWith("insufficient signatures");
        });

        it("reverts when the underlying call fails", async function () {
            // registerParticipant with zero participantId should fail
            const data = target.interface.encodeFunctionData("registerParticipant", [
                ethers.ZeroHash, 0, 0, [], [], []
            ]);
            const sig = await signMultiSigTx(signerA, multiSig, await target.getAddress(), 0n, data);
            await expect(
                multiSig.executeTransaction(await target.getAddress(), 0n, data, [sig])
            ).to.be.revertedWith("execution failed");
        });
    });

    // ── Multi-signer (2-of-3) execution ──────────────────────────────────────────

    describe("2-of-3 executeTransaction", function () {
        beforeEach(async function () {
            // Sort signers by address (ascending) so tests are deterministic
            const sorted = [signerA, signerB, signerC].sort((a, b) =>
                a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1
            );
            [signerA, signerB, signerC] = sorted;

            const MS = await ethers.getContractFactory("MockMultiSig");
            multiSig = await MS.deploy([signerA.address, signerB.address, signerC.address], 2n);
            await multiSig.waitForDeployment();

            const PR = await ethers.getContractFactory("ParticipantRegistry");
            target = await PR.deploy(await multiSig.getAddress());
            await target.waitForDeployment();
        });

        it("executes with exactly threshold signatures", async function () {
            const targetAddr = await target.getAddress();
            const data = target.interface.encodeFunctionData("registerParticipant", [
                ethers.keccak256(ethers.toUtf8Bytes("MULTI")), 0, 0, [], [], []
            ]);

            // Collect signatures and pair with address for sorting
            const sigPairs = await Promise.all(
                [signerA, signerB].map(async s => ({
                    sig:  await signMultiSigTx(s, multiSig, targetAddr, 0n, data),
                    addr: s.address,
                }))
            );
            sigPairs.sort((a, b) => a.addr.toLowerCase() < b.addr.toLowerCase() ? -1 : 1);

            await expect(
                multiSig.executeTransaction(targetAddr, 0n, data, sigPairs.map(p => p.sig))
            ).to.emit(multiSig, "Executed");
        });

        it("reverts with only one signature when threshold is 2", async function () {
            const targetAddr = await target.getAddress();
            const data = "0x";
            const sig  = await signMultiSigTx(signerA, multiSig, targetAddr, 0n, data);
            await expect(
                multiSig.executeTransaction(targetAddr, 0n, data, [sig])
            ).to.be.revertedWith("insufficient signatures");
        });

        it("reverts with duplicate signer signatures", async function () {
            const targetAddr = await target.getAddress();
            const data = "0x";
            const sig  = await signMultiSigTx(signerA, multiSig, targetAddr, 0n, data);
            // Pass same signer twice — should fail on ascending-order check
            await expect(
                multiSig.executeTransaction(targetAddr, 0n, data, [sig, sig])
            ).to.be.revertedWith("signatures not in order / duplicate");
        });
    });

    // ── Ownership transfer via multiSig ──────────────────────────────────────────

    describe("ownership transfer of governance contracts", function () {
        it("can transfer ParticipantRegistry ownership through the multi-sig", async function () {
            const MS = await ethers.getContractFactory("MockMultiSig");
            multiSig = await MS.deploy([signerA.address], 1n);
            await multiSig.waitForDeployment();

            const PR = await ethers.getContractFactory("ParticipantRegistry");
            target = await PR.deploy(await multiSig.getAddress());
            await target.waitForDeployment();

            expect(await target.owner()).to.equal(await multiSig.getAddress());

            // Transfer ownership to signerB via multiSig
            const data = target.interface.encodeFunctionData("transferOwnership", [signerB.address]);
            const sig  = await signMultiSigTx(signerA, multiSig, await target.getAddress(), 0n, data);
            await multiSig.executeTransaction(await target.getAddress(), 0n, data, [sig]);

            expect(await target.owner()).to.equal(signerB.address);
        });

        it("can receive ETH (for funding oracle wallets)", async function () {
            const MS = await ethers.getContractFactory("MockMultiSig");
            multiSig = await MS.deploy([signerA.address], 1n);
            await multiSig.waitForDeployment();

            await signerA.sendTransaction({ to: await multiSig.getAddress(), value: ethers.parseEther("1.0") });
            const balance = await ethers.provider.getBalance(await multiSig.getAddress());
            expect(balance).to.equal(ethers.parseEther("1.0"));
        });
    });
});
