class UserCreator
  def self.call(params)
    new(params).call
  end

  def initialize(params)
    @params = params
  end

  def call
    user = User.create!(@params)
    WelcomeEmailJob.perform_later(user.id)
    UserMailer.welcome(user).deliver_later
    user
  end

  private

  def audit!
    AuditLog.create!(action: "user.created")
  end
end
