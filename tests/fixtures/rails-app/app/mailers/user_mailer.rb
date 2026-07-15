class UserMailer < ApplicationMailer
  default from: "hello@example.com"

  def welcome(user)
    @user = user
    mail(to: @user.email, subject: "Welcome")
  end

  def goodbye(user)
    @user = user
    mail(to: @user.email, subject: "Goodbye")
  end
end
