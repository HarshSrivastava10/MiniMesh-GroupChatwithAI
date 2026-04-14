require('dotenv').config()

const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const express = require('express');
const http = require('http');
const mongoose = require('mongoose')
const {Server} = require('socket.io');
const OpenAI = require('openai');
const client = new OpenAI({apiKey: process.env.OPENROUTER_API_KEY, baseURL: "https://openrouter.ai/api/v1"});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

//

mongoose.connect(process.env.MONGODB_CONNECT + "Info-Users");

mongoose.connection.on("connected", () => {
    console.log("Database connected")
});

const userSchema = new mongoose.Schema({
    username: {type: String, unique: true},
    preferences: [String],
    facts: [String]
});

const User = mongoose.model("User", userSchema);
//

const userMemory = {};
const userHistory = {};
const globalHistory = [];
const userRateLimit = {};

app.use(express.static(__dirname));

io.on("connection", (socket) => {
    console.log("User connected: ", socket.id);

    socket.on("set username", async (username) => {
        if (!userHistory[username]) {
            userHistory[username] = [];
        }
        console.log("Username set: ", username);
        socket.username = username;

        let user = await User.findOne({username});

        if (!user) {
            user = await User.create({
                username,
                preferences: [],
                facts: []
            });
        }

        userMemory[username] = {
            name: username,
            preferences: user.preferences || [],
            facts: user.facts || []
        };
    });

    socket.on("chat message", async (msg) => {
        if (!socket.username) return;


        const isPublic = msg.trim().toLowerCase().startsWith("@bot");
        const isPrivate = msg.trim().toLowerCase().startsWith("@me");
        const isForget = msg.trim().toLowerCase().startsWith("@forget");
        const isClear = msg.trim().toLowerCase().startsWith("@clear");
        

        const fullMsg = `${socket.username}: ${msg}`;
        if(isPrivate || isForget || isClear){
            socket.emit("chat message", fullMsg); // only sender sees and bot 
        }
        else{
            io.emit("chat message", fullMsg); // everyone sees
        }
        if(!userMemory[socket.username]) {
            userMemory[socket.username] = {
                name: socket.username,
                preferences: null,
                facts: []
            };
        }
        if(!isForget && !isClear){
            userHistory[socket.username].push(`${socket.username}: ${msg}`);
            if (userHistory[socket.username].length > 10){
                userHistory[socket.username].shift();
            }
        }

        if (!isForget && !isClear && !isPrivate) {
            globalHistory.push(`${socket.username}: ${msg}`);
            if (globalHistory.length > 20){
                globalHistory.shift();
            }
        }

        // -- PREFERENCES --
        const likeMatch = msg.toLowerCase().match(/i like (.+)/);
        if (likeMatch) {
            let value = likeMatch[1].trim();
            //normalize                                   // to remove punctuation
            value = value.replace(/also|too|as well/g, "").replace(/[^\w\s,]/g, "").trim();

            const items = value.split("/,| and ");
            for (let item of items) {
                item = item.trim();

                if(
                    item.length > 1 &&
                    !userMemory[socket.username].preferences.includes(item)
                ){
                    userMemory[socket.username].preferences.push(item);
                }
            }

            // limit size
            if (userMemory[socket.username].preferences.length > 10) {
                userMemory[socket.username].preferences.shift();
            }

            await User.updateOne(
                { username: socket.username},
                { 
                    $set: {
                        preferences: userMemory[socket.username].preferences
                    } 
                }
            );
        }
        
        // -- FACTS --
        const factMatch = msg.toLowerCase().match(/i am (.+)/);
        if (factMatch) {
            let value = factMatch[1].trim();

            value = value.replace(/[^\w\s]/g, "").replace(/^a |^an |^the /, "").replace(/also|too|as well/g, "").trim();
            
            if(
                value.length>2 && 
                !["ok", "fine", "good"].includes(value) &&
                !userMemory[socket.username].facts.includes(value)
            ){
                userMemory[socket.username].facts.push(value);

                // limit size
                if (userMemory[socket.username].facts.length > 10) {
                    userMemory[socket.username].facts.shift();
                }

                await User.updateOne(
                    { username: socket.username},
                    { 
                        $set: {
                            facts: userMemory[socket.username].facts
                        } 
                    }
                );
            }
        }

        // -- @forget <item> -> to remove a specific thing from the bot's memory
        // -- @clear         -> to remove everything

        // -- FORGET SPECIFIC preference/facts
        const forgetMatch = msg.toLowerCase().match(/^@forget (.+)/);
        
        if (forgetMatch) {
            const value = forgetMatch[1].toLowerCase().replace(/[^w\s]/g, "").replace(/also|too|as well/g, "").trim();

            userMemory[socket.username].preferences = userMemory[socket.username].preferences.filter(p => p != value);

            userMemory[socket.username].facts = userMemory[socket.username].facts.filter(f => f != value);

            await User.updateOne(
                {username: socket.username},
                {
                    $set: {
                        preferences: userMemory[socket.username].preferences,
                        facts: userMemory[socket.username].facts
                    }
                }
            );

            socket.emit("chat message", `BOT (private): Removed "${value}" from memory`);
            return;
        }

        // -- Clear All MEMORY
        if (msg.toLowerCase().startsWith("@clear")) {
            userMemory[socket.username].preferences = [];
            userMemory[socket.username].facts = [];

            await User.updateOne(
                {username: socket.username},
                {
                    $set: {
                        preferences: [],
                        facts: []
                    }
                }
            );

            socket.emit("chat message", `BOT (private): Memory cleared`);
            return;
        }



        const relevantPreferences = userMemory[socket.username].preferences.slice(-3);
        const relevantFacts = userMemory[socket.username].facts.slice(-3);
        const recentRelevant = userHistory[socket.username] || [];

        
        if (isPublic || isPrivate) {

            const now = Date.now();

            if(!userRateLimit[socket.username]) {
                userRateLimit[socket.username] = 0;
            }

            if(now - userRateLimit[socket.username] < 5000){
                socket.emit("chat message", "BOT (private): Slow down. Try again in a few seconds.");
                return;
            }

            userRateLimit[socket.username] = now;

            const cleanMsg = msg.replace(/@bot/gi, "").replace(/@me/gi, "").trim();

            const groupSignals = globalHistory.slice(-5).filter(line => !line.startsWith(socket.username));

            const useGroupContext = groupSignals.length > 0 && cleanMsg.length > 15;

            const messages = [
                {
                    role: "system",
                    content: `
                    You are an AI assistant inside a group chat.
                    Rules:
                    - Speak like a normal human in chat
                    - Do NOT repeat "User" or "Message"
                    - Do NOT expose memory directly
                    - Keep replies short and natural for casual conversation
                    - But if the user asks to "explain", "teach", or "describe", give a clear and detailed description
                    - Use the user's name ONLY occasionally, not in every reply
                    - Avoid repeating greetings like "Hey" every time
                    - Avoid repeating similar sentence openings across replies`.trim()
                },
                {
                    role: "user",
                    content: `
                    You are replying to: ${socket.username}

                    IMPORTANT:
                    - The current user is ${socket.username}
                    - Do NOT confuse with other names in conversation
                    - Address ONLY this user

                    Recent conversations:
                    ${recentRelevant.join('\n')}

                    ${useGroupContext ? `Group Context: ${groupSignals.join('\n')}`: ""}

                    Known info:
                    Preferences: ${relevantPreferences.length ? relevantPreferences.join(", ") : "None"}
                    Facts: ${relevantFacts.length ? relevantFacts.join(", ") : "None"}

                    Message:
                    ${cleanMsg}`.trim()
                }
            ];

            let botReply = "Error generating response.";

            try {
                const response = await client.chat.completions.create({
                    model: "meta-llama/llama-3-8b-instruct",
                    messages: messages
                });

                botReply = response.choices[0].message.content;
            }catch(err){
                console.error(err);
            }
            
            const words = botReply.split(" ");
            
            // for private chat with the bot
            if(isPrivate) {
                
                const messageId = Date.now();

                socket.emit("chat message", {
                    id: messageId,
                    text: "BOT (private): "
                });

                let partial = "";
                let i = 0;

                const interval = setInterval(() => {
                    if(i < words.length){
                        partial += words[i] + " ";

                        socket.emit("chat update", {
                            id: messageId,
                            text: `BOT (private): ${partial}`
                        });
                        i++;
                    }
                    else{
                        clearInterval(interval);
                    }
                }, 80);
            }

            else{
                const messageId = Date.now();

                io.emit("chat message", {
                    id: messageId,
                    text: "BOT (private): "
                });

                let partial = "";
                let i = 0;

                const interval = setInterval(() => {
                    if(i < words.length){
                        partial += words[i] + " ";

                        io.emit("chat update", {
                            id: messageId,
                            text: `BOT (private): ${partial}`
                        });
                        i++;
                    }
                    else{
                        clearInterval(interval);
                    }
                }, 80);
                
            }
        }
    });


    socket.on("disconnect", () => {
        console.log("User disconnected:", socket.id);
    });
});



server.listen(3000, () => {
    console.log("Server running on port 3000");
})
