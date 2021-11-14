const express = require('express')
const cookieParser = require('cookie-parser')
const StormDB = require("stormdb")
const fetch = require('cross-fetch')
const { Server } = require("socket.io")
const { createServer } = require("http")
require("dotenv")

const app = express()
const port = process.env.PORT
const httpServer = createServer(app);
const io = new Server(httpServer,{  
    cors: {    
      origin: "*",     
    }
});
const engine = new StormDB.localFileEngine(process.env.DBPATH)
const db = new StormDB(engine)
db.default({ users: []}).save()

app.use(cookieParser())
app.use(express.json())
app.use(express.urlencoded({extended: false}))

var connectedusers = {}

function Authenticate(req, resp, callback, failcallback=(err)=>{res.send(JSON.stringify({"success":false,"error":"Token is invalid or has expired!"}))}){
    fetch(`https://discord.com/api/v8/oauth2/@me`,{headers: {'Authorization':`Bearer ${req.headers.token}`}})
    .then(res => {
    if (res.status >= 400) {
        const err = new Error("Bad response from server")
        err.code = res.status
        throw err
    }
        return res.json();
    })
    .then(res => {
        if(res.application.id === process.env.DISCORD_APP_ID) {
            var users = db.get("users").value()
            var user = users.find(user => user.discordid == res.user.id)
            if(user==undefined){
                var newuser = {
                    discordid:res.user.id,
                    username:res.user.username,
                }
                console.log("User does not exist but the token is valid\nCreating user account...")
                db.get("users").push(newuser).save()
                var user = users.find(user => user.discordid == res.user.id)
                callback(user,req,resp)
            }else{
                callback(user,req,resp)
            }
        }else{
            failcallback(req,resp)
        }
    })
    .catch(err => {failcallback(req,resp,err)})
    
}

app.post('/auth/gettoken', (req,res)=>{
    var details = {
        'client_id': process.env.DISCORD_APP_ID,
        'client_secret': process.env.DISCORD_APP_SECRET,
        'grant_type': 'authorization_code',
        'code':req.body.code,
        'redirect_uri':process.env.DISCORD_APP_REDIRECT_URI
    }

    var formBody = []
    for (var property in details) {
    var encodedKey = encodeURIComponent(property)
    var encodedValue = encodeURIComponent(details[property])
    formBody.push(encodedKey + "=" + encodedValue)
    }
    formBody = formBody.join("&")

    fetch(`https://discord.com/api/v8/oauth2/token`,{
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
        },
        body: formBody
    }).then(resp => {
        if (resp.status >= 400) {
            const err = new Error("Bad response from server")
            err.code = resp.status
            throw err
        }
            return resp.json();
        }
    )
    .then(resp => {
        res.send(JSON.stringify({success: true, token: resp.access_token}))
    }).catch(err => {
        res.send(JSON.stringify({success: false, error: "Invalid OAuth 2.0 code"}))
    })
})

io.on("connection", socket => {
    console.log("\nUser "+socket.id+" trying to connect to websocket server...")
    const token = socket.handshake.auth.token;
    Authenticate({headers: {'token':token}},undefined,(userinfo)=>{
        socket.emit("userinfo", userinfo)
        console.log("User "+socket.id+" was authorized as "+userinfo.username+"("+userinfo.discordid+")")
        connectedusers[socket.id] = userinfo
        socket.on("joinrequest", joindata => {
            console.log(connectedusers)
            var users = db.get("users").value()
            var user = users.find(user => user.discordid == joindata.userid)
            if(user==undefined){
                console.log("sending rejection")
                socket.emit("joinresponse",{accepted:false,error:"Invalid token"})
            }else{
                socketid = Object.keys(connectedusers)[Object.values(connectedusers).findIndex(fuser => fuser.discordid == joindata.userid)]
                if(connectedusers[socketid].ongoingjoin || connectedusers[socket.id].ongoingjoin){
                    socket.emit("joinresponse",{accepted:false,error:"User is joining/being joined"})
                }else{
                    connectedusers[socketid].ongoingjoin = true
                    connectedusers[socket.id].ongoingjoin = true
                    io.to(socketid).emit("requestjoinresponse",{name:userinfo.username,userid:userinfo.discordid,...joindata})
                }
            }
        })

        socket.on("sendjoinresponse", joinresponse => {
            socketid = Object.keys(connectedusers)[Object.values(connectedusers).findIndex(user => user.discordid == joinresponse.userid)]
            if(connectedusers[socket.id].ongoingjoin && connectedusers[socketid].ongoingjoin){
                io.to(socketid).emit("joinresponse",{name:userinfo.username,userid:userinfo.discordid,...joinresponse.packet})
                connectedusers[socketid].ongoingjoin = false
                connectedusers[socket.id].ongoingjoin = false
            }else{
                console.log("Unauthorized join response from "+connectedusers[socket.id].username+" to "+connectedusers[socketid].username)
            }
        })

        socket.on("disconnect", (reason) => {
            console.log("\nUser "+socket.id+" disconnected because of "+reason)
            delete connectedusers[socket.id]
            console.log(connectedusers)
        })
    },()=>{
        console.log("User "+socket.id+" was not authorized and will be disconnected")
        socket.disconnect(true)
    })
});

app.get("/",(req,res) =>{
    res.send(`<script src="/socket.io/socket.io.js"></script>`)
})

//setInterval(console.log,10000,connectedusers)

httpServer.listen(port)
console.log("Server listening on port "+port)