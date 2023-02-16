import * as borsh from "@project-serum/borsh"
import { PublicKey } from "@solana/web3.js"

type Symbol = "x"|"o"|null

export class Game {
    players: string[]
    board: Symbol[][]
    state: string
    turns: number
    stakeMint: string
    stakeAmount: number
    isInitialized: boolean

    constructor(playerOne: PublicKey, 
                playerTwo: PublicKey, 
                board: Symbol[][], 
                state: string, 
                turns: number, 
                stakeMint: PublicKey, 
                stakeAmount: number, 
                isInitialized: boolean) {
        this.players = [playerOne.toBase58(), playerTwo.toBase58()]
        this.board = board
        this.state = state
        this.turns = turns
        this.stakeMint = stakeMint.toBase58()
        this.stakeAmount = stakeAmount
        this.isInitialized = isInitialized
    }

    static borshAccountSchema = borsh.struct([
        borsh.array(borsh.publicKey(), 2, "players"),
        borsh.array(borsh.array(borsh.option(borsh.rustEnum([borsh.struct([], "x"), borsh.struct([], "y")])), 3), 3, "board"),
        borsh.rustEnum([borsh.struct([], "unaccepted"), borsh.struct([], "ongoing"), borsh.struct([borsh.publicKey("winner")], "over"), borsh.struct([], "draw")], "state"),
        borsh.u8("turns"),
        borsh.publicKey("stakeMint"),
        borsh.u64("stakeAmount"),
        borsh.bool("isInitialized"),
    ])

    static deserialize(buffer?: Buffer): Game|null {
        if (!buffer)
            return null
        try {
        } catch (err) {
            console.log("deserialization error", err)
        }
    }
}