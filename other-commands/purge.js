module.exports = {
    name: 'purge',
    description: 'Deletes a specified number of messages from the channel',
    async execute(message, args) {
      if (!message.member.permissions.has('MANAGE_MESSAGES')) {
        return message.reply('You do not have permissions to manage messages.');
      }
  
      const amount = parseInt(args[0]);
  
      if (isNaN(amount) || amount <= 0 || amount > 100) {
        return message.reply('Please provide a number between 1 and 100 for the number of messages to delete.');
      }
  
      try {
        const deletedMessages = await message.channel.bulkDelete(amount, true);
        message.channel.send(`Successfully deleted ${deletedMessages.size} messages.`)
          .then(msg => {
            setTimeout(() => msg.delete(), 5000);
          });
      } catch (error) {
        console.error(error);
        message.reply(`\`\`\`There was an error trying to delete messages in this channel.\n${error}\`\`\``);
      }
    },
  };
  