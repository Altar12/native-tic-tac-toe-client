import promptSync from "prompt-sync"
import { PublicKey,
         Connection,
         clusterApiUrl,
         Keypair,
         TransactionInstruction,
         Transaction,
         SystemProgram,
         AccountInfo,
         sendAndConfirmTransaction } from "@solana/web3.js"
import * as fs from "fs"
import { isValidAddress,
         isValidNumber,
         Game,
         createGameInstructionLayout } from "./auxiliary"
import { getAssociatedTokenAddressSync,
         getAccount,
         getMint, 
         Mint, 
         Account,
         TOKEN_PROGRAM_ID } from "@solana/spl-token"
import { BN } from "@project-serum/anchor"

// configurations
//const programId = new PublicKey("EDc3WwozrtSCmZCQSa4v8Mqw5kup5bsxuTNLyD8bEzEZ")
const programId = new PublicKey("7Y8kCjUujms2w26ruzHUpayKQMtzJcnVPJzVuVWgBio1")
const connection = new Connection(clusterApiUrl("devnet"), "confirmed")
const prompter = promptSync()

function main() {

    // check that program has correct number of arguments
    if (process.argv.length !== 3) {
        console.error("Invalid argument count...")
        console.log("Correct usage: ts-node <PATH-TO-PROGRAM-FILE> <PATH-TO-USER-KEYPAIR-FILE>")
        return
    }

    // check whether file specified exists or not
    const filePath = process.argv[2]
    if (!fs.existsSync(filePath)) {
        console.error("The user keypair file specified does not exist...")
        return
    }

    // try to read user user keypair from the file specified
    const fileContent = fs.readFileSync(filePath, "utf-8")
    let userKeypair: Keypair
    try {
      const secretKey = Uint8Array.from(JSON.parse(fileContent) as number[])
      userKeypair = Keypair.fromSecretKey(secretKey)
      console.log("User:", userKeypair.publicKey.toBase58())
    } catch (err) {
      console.error("Could not retrieve keypair from the provided file...")
      console.log("Check that the file content is a valid keypair")
      return
    }

    // prompt user to select an option
    console.log("1. Create a Game\n2. Resume a Game\n3. Accept a Game\n4. Cancel a Game\n")
    const choice: string = prompter("Your choice: ").trim()

    // perform the selected operation
    switch (choice) {
        case "1":
            createGame(userKeypair)
            break
        case "2":
            resumeGame(userKeypair)
            break
        case "3":
            acceptGame(userKeypair)
            break
        case "4":
            cancelGame(userKeypair)
            break
        default:
            console.error("Invalid selection...")
    }
}
main()

async function playGame(user: Keypair, gameAddress: PublicKey) {
    
}

async function createGame(user: Keypair) {

    // get the opponent's address
    let input: string = prompter("Enter the address of opponent: ").trim()
    if (!isValidAddress(input)) {
        console.error("Input does not correspond to a valid address...")
        return
    }
    const playerTwo = new PublicKey(input)

    // get the mint address of token to stake
    input = prompter("Enter mint address of the token to stake: ").trim()
    if (!isValidAddress(input)) {
        console.error("Input does not correspond to a valid address...")
        return
    }
    const mint = new PublicKey(input)

    // fetch mint details and user's ata, display info to user
    let mintInfo: Mint
    let tokenAccount: Account
    try {
        mintInfo = await getMint(connection, mint)
        const accountAddress = getAssociatedTokenAddressSync(mint, user.publicKey)
        tokenAccount = await getAccount(connection, accountAddress)
    } catch (err) {
        console.error(err)
        console.log("Check that address entered corresponds to a mint and you have an associated token account for the mint")
        return
    }
    if (Number(tokenAccount.amount) === 0) {
        console.error("Your token balance for the given mint is zero...")
        return
    }
    console.log("Your token balance:", Number(tokenAccount.amount)/(10 ** mintInfo.decimals))

    // get the amount of tokens to stake
    input = prompter(`Enter the amount of tokens to stake(upto ${mintInfo.decimals} decimal places): `).trim()
    if (!isValidNumber(input)) {
        console.error("Input does not correspond to a valid number...")
        return
    }
    if (input.includes(".") && input.split(".")[1].length > mintInfo.decimals) {
        console.error("Your input exceeds the maximum decimal places allowed for the token...")
        return
    }
    const stakeAmount = Number(input) * (10 ** mintInfo.decimals)
    if (stakeAmount > Number(tokenAccount.amount)) {
        console.error("Stake amount specified exceeds the token balance...")
        return
    }

    // create & send transaction to create a new game
    const gameAddress = await sendCreateGameTxn(user, playerTwo, mint, tokenAccount.address, stakeAmount)

    // wait for other user to accept the game
    console.log("Waiting for other player to accept the game...")
    let accountInfo: AccountInfo<Buffer>
    while (true) {
        await new Promise(f => setTimeout(f, 2000))
        accountInfo = await connection.getAccountInfo(gameAddress)
        if (Game.isValidOngoingGame(accountInfo.data))
            break
    }

    // start playing the game
    await playGame(user, gameAddress)
}

async function resumeGame(user: Keypair) {

    let input: string
    // fetch all the games where user is a player
    const initiatedGames = await connection.getProgramAccounts(programId, {
                                filters: [
                                    {
                                        memcmp: {
                                            offset: 0,
                                            bytes: user.publicKey.toBase58(),
                                        }
                                    }
                                ]
                            })
    const acceptedGames = await connection.getProgramAccounts(programId, {
                                filters: [
                                    {
                                        memcmp: {
                                            offset: 32,
                                            bytes: user.publicKey.toBase58()
                                        }
                                    }
                                ]
                            })

    // filter for playable games
    const allGames = initiatedGames.concat(acceptedGames)
    let playableGames: Game[] = []
    let game: { pubkey: PublicKey,
                account: AccountInfo<Buffer> 
              }
    for (let i=0; i<allGames.length; ++i) {
        game = allGames[i]
        if (Game.isValidOngoingGame(game.account.data))
            playableGames.push(await Game.deserialize(game.account.data, user.publicKey, game.pubkey))
    }
    if (playableGames.length === 0) {
        console.log("You do not have any ongoing games at the moment...")
        return
    }

    // prompt user to select game to resume
    let selectedGame: PublicKey
    if (playableGames.length === 1) {
        const game = playableGames[0]
        console.log("You only have one ongoing game")
        console.log("Address:", game.address.toBase58())
        console.log("Opponent:", game.opponent)
        console.log(`Stake: ${game.stakeAmount} of ${game.stakeMint}`)
        console.log("Turns remaining:", game.turnsRemaining)
        input = prompter("Would you like to resume this game?(y/n): ").trim().toLowerCase()
        switch (input) {
            case "y": selectedGame = game.address
                      break
            case "n": console.log("Exiting...")
                      return
            default: console.error("Invalid input...")
                      return
        }
    } else {
        console.log("List of ongoing games:")
        playableGames.forEach((game, index) => {
            console.log("Game", index+1)
            console.log("Address:", game.address.toBase58())
            console.log("Opponent:", game.opponent)
            console.log(`Stake: ${game.stakeAmount} of ${game.stakeMint}`)
            console.log("Turn remaining:", game.turnsRemaining)
            console.log("---------------------------------")
        })
        input = prompter("Enter the game number you would like to resume: ").trim()
        if (!isValidNumber(input) || input.includes(".") || Number(input) < 1 || Number(input) > playableGames.length) {
            console.error("Invalid input...")
            return
        }
        selectedGame = playableGames[Number(input)-1].address
    }

    // start playing the selected game
    await playGame(user, selectedGame)
}

async function acceptGame(user: Keypair) {

}

async function cancelGame(user: Keypair) {

}

async function sendCreateGameTxn(
    user: Keypair,
    playerTwo: PublicKey,
    stakeMint: PublicKey,
    tokenAccount: PublicKey,
    stakeAmount: number
): Promise<PublicKey> {
        // prepare instruction data
        let buffer = Buffer.alloc(1000)
        createGameInstructionLayout.encode({ variant: new BN(0), playerTwo, stakeAmount: new BN(stakeAmount) }, buffer)
        buffer = buffer.slice(0, createGameInstructionLayout.getSpan(buffer))

        // create new keypair for the game
        const gameKeypair = Keypair.generate()

        // find escrow account pubkey for the token
        const [escrow] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), stakeMint.toBuffer()], programId)

        // prepare and send transaction
        const instruction = new TransactionInstruction({
            keys: [
                createAccountMeta(user.publicKey, true, true),
                createAccountMeta(gameKeypair.publicKey, true, true),
                createAccountMeta(stakeMint, false, false),
                createAccountMeta(escrow, false, true),
                createAccountMeta(tokenAccount, false, true),
                createAccountMeta(TOKEN_PROGRAM_ID, false, false),
                createAccountMeta(SystemProgram.programId, false, false),
            ],
            programId,
            data: buffer,
        })
        const transaction = new Transaction().add(instruction)
        await sendAndConfirmTransaction(connection, transaction, [user, gameKeypair])
        return gameKeypair.publicKey
  }

function createAccountMeta(
    pubkey: PublicKey,
    isSigner: boolean,
    isWritable: boolean
): { pubkey: PublicKey,
     isSigner: boolean,
     isWritable: boolean }
{
    return { pubkey, isSigner, isWritable }
}