import * as borsh from "@project-serum/borsh"
import { PublicKey, Connection, clusterApiUrl } from "@solana/web3.js"
import { getMint } from "@solana/spl-token"

type Symbol = "X"|"O"|" "

export class Game {
    address: PublicKey
    opponent: string
    board: Symbol[][]
    turnsRemaining: number
    stakeMint: string
    stakeAmount: number     // includes decimal

    constructor(address: PublicKey,
                opponent: string,
                board: Symbol[][],
                turnsRemaining: number,
                stakeMint: string,
                stakeAmount: number) {
        this.address = address
        this.opponent = opponent
        this.board = board
        this.turnsRemaining = turnsRemaining
        this.stakeMint = stakeMint
        this.stakeAmount = stakeAmount
    }

    static borshAccountSchema = borsh.struct([
        borsh.array(borsh.publicKey(), 2, "players"),
        borsh.array(borsh.array(borsh.option(borsh.rustEnum([borsh.struct([], "x"), borsh.struct([], "y")])), 3), 3, "board"),
        borsh.u8("stateDiscriminator"),
        borsh.u8("turns"),
        borsh.publicKey("stakeMint"),
        borsh.u64("stakeAmount"),
        borsh.bool("isInitialized"),
    ])

    static isValidOngoingGame(buffer: Buffer): boolean {
      try {
        const { stateDiscriminator, isInitialized } = this.borshAccountSchema.decode(buffer)
        if (stateDiscriminator > 1 || !isInitialized)
          return false
      } catch (err) {
        return false
      }
      return true
    }

    // will call isValidOngoingGame first, only the accounts that return true will be deserialized by calling below function
    // so not putting the decode construct in try catch
    static async deserialize(buffer: Buffer, player: PublicKey, gameAddress: PublicKey): Promise<Game> {
      // deserializing the buffer and extracting the required fields
      const { players, board, turns, stakeMint, stakeAmount } = this.borshAccountSchema.decode(buffer)
      
      // setting the opponent address
      let opponent: string
      if (player.toBase58() === players[0].toBase58())
        opponent = players[1].toBase58()
      else 
        opponent = players[0].toBase58()

      // getting the mint details (for setting decimals in the stakeAmount)
      const mintInfo = await getMint(
                              new Connection(clusterApiUrl("devnet"), "confirmed"),
                              stakeMint
                              )

      // constructing the board to be displayed
      let displayBoard: Symbol[][] = []
      let tile: { x?: {}, o?: {} }
      for (let i=0; i<3; ++i) {
        displayBoard.push([])
        for (let j=0; j<3; ++j) {
          tile = board[i][j]
          if (!tile)
            displayBoard[i].push(" ")
          else if (tile.x)
            displayBoard[i].push("X")
          else
            displayBoard[i].push("O")
        }
      }

      return new Game(gameAddress, opponent, displayBoard, 9-turns, stakeMint.toBase58(), Number(stakeAmount)/(10 ** mintInfo.decimals))
    }
}

// instruction data layout for creating a game
export const createGameInstructionLayout = borsh.struct([
                                            borsh.u8("variant"),
                                            borsh.publicKey("playerTwo"),
                                            borsh.u64("stakeAmount"),
                                    ])

// instruction data layout for playing a game
export const playGameInstructionSchema = borsh.struct([
                                            borsh.u8("variant"),
                                            borsh.u8("row"),
                                            borsh.u8("col"),
                                    ])

// instruction data layout for all the other options
export const gameInstructionLayout = borsh.struct([ borsh.u8("variant") ])

export function isValidAddress(input: string): boolean {
    if (input.length < 32 || input.length > 44)
      return false
    let asciiValue: number
    for (let index=0; index<44; index++) {
      asciiValue = input.charCodeAt(index)
      if (asciiValue>47 && asciiValue<58
          || asciiValue>64 && asciiValue<91
          || asciiValue>96 && asciiValue<123)
          continue
      return false
    }
    if (input.includes("0")
        || input.includes("I")
        || input.includes("O")
        || input.includes("l"))
      return false
    return true
}
  
export function isValidNumber(input: string): boolean {
    if (input.length === 0) 
      return false
    let periodFound = false
    let asciiValue: number
    for (let index=0; index<input.length; ++index) {
      if (input[index] === ".") {
        if (periodFound)
          return false
        periodFound = true
        continue
      }
      asciiValue = input.charCodeAt(index)
      if (asciiValue<48 || asciiValue>57)
        return false
    }
    return true
}