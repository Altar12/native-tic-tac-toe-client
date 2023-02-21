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
         createGameInstructionLayout,
         playGameInstructionLayout } from "./auxiliary"
import { getAssociatedTokenAddressSync,
         getAccount,
         getMint, 
         Mint, 
         Account,
         TOKEN_PROGRAM_ID } from "@solana/spl-token"
import { BN } from "@project-serum/anchor"
import bs58 from "bs58"

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

    let input: string
    let currentPlayerIndex: number
    let userIndex: number
    let gameAccount: AccountInfo<Buffer>
    let rowString: string
    let columnString: string
    let row: number
    let column: number
    type Tile = { x?: {}, y?: {} }|null

    // function to get the print character for a tile
    function getTileCharacter(tile: Tile): string {
        if (!tile)
            return " "
        else if (tile.x)
            return "X"
        else
            return "O"
    }

    // function to get user input for the next move
    function getTileToMark(board: Tile[][]): boolean {
        input = prompter("\nEnter the row & column of tile to mark (space separated): ").trim()
        rowString = input.split(" ")[0]
        columnString = input.substring(input.indexOf(" ")).trim()
        if (!isValidNumber(rowString) || !isValidNumber(columnString) || rowString.includes(".") || columnString.includes(".")) {
            console.error("Invalid input...")
            return false
        }
        row = Number(rowString)
        column = Number(columnString)
        if (row>3 || column>3) {
            console.error("The input exceeds the tile bound...")
            return false
        }
        if (board[row][column]) {
            console.error("The tile specified is already marked...")
            return false
        }
        return true
    }
    
    // fetch the game account and initialize player indexes
    gameAccount = await connection.getAccountInfo(gameAddress)
    if (!Game.isValidOngoingGame(gameAccount.data)) {
        console.error("The passed address does not correspond to a valid ongoing game...")
        console.log("Check the game address again")
        return
    }
    let { players, board, turns } = Game.borshAccountSchema.decode(gameAccount.data)
    if (players[0].toBase58() === user.publicKey.toBase58())
        userIndex = 0
    else if (players[1].toBase58() === user.publicKey.toBase58()) 
        userIndex = 1
    else {
        console.error("User is not a player of the passed game...")
        return
    }
    if (turns%2 === 0)
        currentPlayerIndex = 0
    else 
        currentPlayerIndex = 1

    // print the board
    console.log("--------------------------")
    for (let i=0; i<3; ++i) {
        console.log(`\t${getTileCharacter(board[i][0])}\t${getTileCharacter(board[i][1])}\t${getTileCharacter(board[i][2])}`)
        console.log("--------------------------")
    }

    // play game logic
    while (Game.isValidOngoingGame(gameAccount.data)) {
        // if user's turn, prompt them to input the next move
        if (userIndex === currentPlayerIndex) {
            // prompt for input until valid input is received
            while (!getTileToMark(board));
            await sendPlayTxn(user, gameAddress, {row, column})
        } else {
            // wait for opponent's move
            console.log("Waiting for opponent's move...")
            while (true) {
                await new Promise(f => setTimeout(f, 2000))
                gameAccount = await connection.getAccountInfo(gameAddress)
                if (!Game.isValidOngoingGame(gameAccount.data))
                    break
                if (Game.borshAccountSchema.decode(gameAccount.data).turns%2 === userIndex)
                    break
            }
        }
        // print the board
        board = Game.borshAccountSchema.decode(gameAccount.data).board
        console.log("--------------------------")
        for (let i=0; i<3; ++i) {
            console.log(`\t${getTileCharacter(board[i][0])}\t${getTileCharacter(board[i][1])}\t${getTileCharacter(board[i][2])}`)
            console.log("--------------------------")
        }
        // update the current player
        currentPlayerIndex = (currentPlayerIndex+1)%2
    }

    let { stateDiscriminator, winner } = Game.borshAccountSchema2.decode(gameAccount.data)
    if (stateDiscriminator === 2) {
        if (winner.toBase58() === user.publicKey.toBase58())
            console.log("$$$$$$$$$ YOU WON THE GAME $$$$$$$$$")
        else
            console.log("You lost the game :(")
    } else 
        console.log("The game resulted in a draw...")
    
    // send transaction to close the game if user is the initiator
    if (userIndex === 0) {
        if (stateDiscriminator === 2) {
            let { stakeMint } = Game.borshAccountSchema2.decode(gameAccount.data)
            await sendCloseGameTxn(user, gameAddress, stakeMint, null, winner)
        } else {
            let { players, stakeMint } = Game.borshAccountSchema.decode(gameAccount.data)
            await sendCloseGameTxn(user, gameAddress, stakeMint, players[1], null)
        }
    }

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

    let input: string
    // fetch all the games where user is player two and are unaccepted
    const gameAccounts = await connection.getProgramAccounts(programId, {
                                            filters: [
                                                {
                                                    memcmp: {
                                                        offset: 32,
                                                        bytes: user.publicKey.toBase58(),
                                                    }
                                                },
                                                {
                                                    memcmp: {
                                                        offset: 32*2+2*9,
                                                        bytes: bs58.encode(new BN(0).toArrayLike(Buffer, "be", 8)),
                                                    }
                                                }
                                            ]
                        })
    if (gameAccounts.length === 0) {
        console.error("You have no pending games to accept...")
        return
    }
    let unacceptedGames: Game[] = []
    for (let i=0; i<gameAccounts.length; ++i) 
        unacceptedGames.push(await Game.deserialize(gameAccounts[i].account.data, user.publicKey, gameAccounts[i].pubkey))

    // prompt user to select game to accept
    let selectedGame: Game
    if (unacceptedGames.length === 1) {
        selectedGame = unacceptedGames[0]
        console.log("You only have one unaccepted game:")
        console.log("Address:", selectedGame.address.toBase58())
        console.log("Opponent:", selectedGame.opponent)
        console.log(`Stake: ${selectedGame.stakeAmount} of ${selectedGame.stakeMint}`)
        input = prompter("Would you like to accept this game?(y/n): ").trim().toLowerCase()
        switch (input) {
            case "n": console.log("Exiting...")
                      return
            case "y": break
            default: console.error("Invalid input...")
                     return
        }
    } else {
        console.log("Games waiting for your acceptance:")
        unacceptedGames.forEach((game, index) => {
            console.log("Game", index+1)
            console.log("Address:", game.address.toBase58())
            console.log("Opponent:", game.opponent)
            console.log(`Stake: ${game.stakeAmount} of ${game.stakeMint}`)
            console.log("------------------------------")
        })
        input = prompter("Enter the game number you would like to accept: ").trim()
        if (!isValidNumber(input) || input.includes(".") || Number(input)<1 || Number(input)>unacceptedGames.length) {
            console.error("Your provided input is invalid...")
            return
        }
        selectedGame = unacceptedGames[Number(input)-1]
    }

    // fetch user's ata and verify whether sufficient balance is present or not
    const tokenAccountAddr = getAssociatedTokenAddressSync(new PublicKey(selectedGame.stakeMint), user.publicKey)
    let tokenAccount: Account
    try {
        tokenAccount = await getAccount(connection, tokenAccountAddr)
    } catch (err) {
        console.error("Error while fetching token account", err)
        console.log("Check that you have token account for the token to stake")
        return
    }
    const mintInfo = await getMint(connection, new PublicKey(selectedGame.stakeMint))
    const tokenBalance = Number(tokenAccount.amount)/(10 ** mintInfo.decimals)
    if (tokenBalance < selectedGame.stakeAmount) {
        console.error("You do not have enough token balance to stake...")
        console.log(`Your balance: ${tokenBalance}, required to stake: ${selectedGame.stakeAmount}`)
        console.log("If you have multiple token accounts for the mint, transfer your tokens to your ATA")
        return
    }

    // send transaction to accept the game
    await sendAcceptGameTxn(user, selectedGame.address, tokenAccount)
    // start playing the game
    await playGame(user, selectedGame.address)
}

async function cancelGame(user: Keypair) {
    let input: string

    // fetch unaccepted games initiated by the user
    const gameAccounts = await connection.getProgramAccounts(programId, {
                                    filters: [
                                        {
                                            memcmp: {
                                                offset: 0,
                                                bytes: user.publicKey.toBase58(),
                                            }
                                        },
                                        {
                                            memcmp: {
                                                offset: 32*2+2*9,
                                                bytes: bs58.encode(new BN(0).toArrayLike(Buffer, "be", 8)),
                                            }
                                        }
                                    ]
                                })
    if (gameAccounts.length === 0) {
        console.log("There are no unaccepted games created by you at the moment...")
        return
    }
    let cancellableGames: Game[] = []
    for (let i=0; i<gameAccounts.length; ++i)
        cancellableGames.push(await Game.deserialize(gameAccounts[i].account.data, user.publicKey, gameAccounts[i].pubkey))

    // prompt user to select game to cancel
    let selectedGame: Game
    if (cancellableGames.length === 1) {
        selectedGame = cancellableGames[0]
        console.log("You have one cancellable game:")
        console.log("Address:", selectedGame.address.toBase58())
        console.log("Opponent:", selectedGame.opponent)
        console.log(`Stake: ${selectedGame.stakeAmount} of ${selectedGame.stakeMint}`)
        input = prompter("Would you like to close this game?(y/n): ").trim().toLowerCase()
        switch (input) {
            case "n": console.log("Exiting...")
                      return
            case "y": break
            default: console.error("Invalid input...")
                     return
        }
    } else {
        console.log("Unaccepted games created by you:")
        cancellableGames.forEach((game, index) => {
            console.log("Game", index+1)
            console.log("Address:", game.address.toBase58())
            console.log("Opponent:", game.opponent)
            console.log(`Stake: ${game.stakeAmount} of ${game.stakeMint}`)
            console.log("-------------------------------------")
        })
        input = prompter("Enter the game number you would like to close: ").trim()
        if (!isValidNumber(input) || input.includes(".") || Number(input)<1 || Number(input)>cancellableGames.length) {
            console.error("Invalid input...")
            return
        }
        selectedGame = cancellableGames[Number(input)-1]
    }
    // get user's token account address to receive staked funds
    const stakeMint = new PublicKey(selectedGame.stakeMint)
    const tokenAccountAddress = getAssociatedTokenAddressSync(stakeMint, user.publicKey)
    // send transaction to cancel the game
    await sendCancelGameTxn(user, selectedGame.address, stakeMint, tokenAccountAddress)
    console.log("Cancelled game successfully...")
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
        const txn = await sendAndConfirmTransaction(connection, transaction, [user, gameKeypair])
        console.log(`https://explorer.solana.com/tx/${txn}?cluster=devnet`)
        return gameKeypair.publicKey
}

async function sendAcceptGameTxn(
    user: Keypair,
    game: PublicKey,
    tokenAccount: Account) {

        // get the escrow account address
        const [escrow] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), tokenAccount.mint.toBuffer()], programId)

        // prepare and send the transaction
        const instruction = new TransactionInstruction({
                                keys: [
                                    createAccountMeta(user.publicKey, true, false),
                                    createAccountMeta(game, false, true),
                                    createAccountMeta(escrow, false, true),
                                    createAccountMeta(tokenAccount.address, false, true),
                                    createAccountMeta(TOKEN_PROGRAM_ID, false, false),
                                ],
                                programId
                            })
        const transaction = new Transaction().add(instruction)
        const txn = await sendAndConfirmTransaction(connection, transaction, [user])
        console.log(`https://explorer.solana.com/tx/${txn}?cluster=devnet`)
}

async function sendCancelGameTxn(
    user: Keypair,
    game: PublicKey,
    stakeMint: PublicKey,
    tokenAccount: PublicKey) {

        // get escrow and authority addresses
        const [escrow] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), stakeMint.toBuffer()], programId)
        const [authority] = PublicKey.findProgramAddressSync([Buffer.from("authority")], programId)

        // prepare and send the transaction
        const instruction = new TransactionInstruction({
            keys: [
                createAccountMeta(user.publicKey, true, false),
                createAccountMeta(game, false, true),
                createAccountMeta(escrow, false, true),
                createAccountMeta(tokenAccount, false, true),
                createAccountMeta(authority, false, false),
                createAccountMeta(TOKEN_PROGRAM_ID, false, false)
            ],
            programId
        })
        const transaction = new Transaction().add(instruction)
        const txn = await sendAndConfirmTransaction(connection, transaction, [user])
        console.log(`https://explorer.solana.com/tx/${txn}?cluster=devnet`)
}

async function sendPlayTxn(
    user: Keypair,
    game: PublicKey,
    tile: {row: number, column: number}
) {
    // prepare instruction data
    let buffer = Buffer.alloc(1000)
    playGameInstructionLayout.encode({ variant: new BN(2), row: new BN(tile.row), col: new BN(tile.column) }, buffer)
    buffer = buffer.slice(0, playGameInstructionLayout.getSpan(buffer))

    // prepare and send transaction
    const instruction = new TransactionInstruction({
                            keys: [
                                createAccountMeta(user.publicKey, true, false),
                                createAccountMeta(game, false, true),
                            ],
                            programId,
                            data: buffer
                        })
    const transaction = new Transaction().add(instruction)
    const txn = await sendAndConfirmTransaction(connection, transaction, [user])
    console.log(`https://explorer.solana.com/tx/${txn}?cluster=devnet`)

}

async function sendCloseGameTxn(
    user: Keypair,
    game: PublicKey,
    stakeMint: PublicKey,
    playerTwo?: PublicKey,
    winner?: PublicKey) {

        // get escrow & authority addresses
        const [escrow] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), stakeMint.toBuffer()], programId)
        const [authority] = PublicKey.findProgramAddressSync([Buffer.from("authority")], programId)

        // prepare list of AccountMetas
        let keys = [
                    createAccountMeta(user.publicKey, false, false),
                    createAccountMeta(game, false, true),
                    createAccountMeta(escrow, false, true),
                    createAccountMeta(authority, false, false),
                    createAccountMeta(TOKEN_PROGRAM_ID, false, false),
                    createAccountMeta(SystemProgram.programId, false, false)
                   ]
        if (winner && !playerTwo) {
            const tokenAccountAddress = getAssociatedTokenAddressSync(stakeMint, winner)
            keys.push(createAccountMeta(tokenAccountAddress, false, true))
        } else if (!winner && playerTwo) {
            let tokenAccountAddress = getAssociatedTokenAddressSync(stakeMint, user.publicKey)
            keys.push(createAccountMeta(tokenAccountAddress, false, true))
            tokenAccountAddress = getAssociatedTokenAddressSync(stakeMint, playerTwo)
            keys.push(createAccountMeta(tokenAccountAddress, false, true))
        } else {
            console.error("Developer error: specify exactly one out of winner and player two")
            console.log("Did not send fund transfer transaction")
            return
        }

        // prepare and send transaction
        const instruction = new TransactionInstruction({
            keys,
            programId,
        })
        const transaction = new Transaction().add(instruction)
        const txn = await sendAndConfirmTransaction(connection, transaction, [user])
        console.log(`https://explorer.solana.com/tx/${txn}?cluster=devnet`)
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