class UsersController < ApplicationController
  include Paginatable

  before_action :authenticate_user!
  before_action :set_user, only: %i[show activate]
  rescue_from ActiveRecord::RecordNotFound, with: :render_not_found

  def index
    @users = User.active
  end

  def show; end

  def create
    @user = UserCreator.call(user_params)
  end

  def activate
    @user.update!(active: true)
  end

  private

  def set_user
    @user = User.find(params[:id])
  end

  def render_not_found
    head :not_found
  end
end
